import React, { memo, useCallback, useState, useEffect, useRef } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { useProceduralStore } from '../store/ProceduralContext';
import { PSDNodeData, VisualAnchor } from '../types';
import { BookOpen, Image as ImageIcon, FileText, Trash2, UploadCloud, BrainCircuit, Loader2, CheckCircle2, AlertCircle, X, Layers } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';

// Initialize PDF Worker from CDN to handle parsing off the main thread
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs';

interface StagedFile {
  id: string;
  file: File;
  type: 'pdf' | 'image';
  preview?: string;
  // Parsing Lifecycle State
  status: 'idle' | 'parsing' | 'complete' | 'error';
  extractedText?: string;
  visualAnchor?: VisualAnchor;
  errorMsg?: string;
}

const extractTextFromPdf = async (file: File): Promise<string> => {
    try {
        const arrayBuffer = await file.arrayBuffer();
        
        // Load the PDF document
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        
        let fullText = '';
        const CHAR_LIMIT = 10000; // Safety Cap for Context Window

        // Iterate through all pages
        for (let i = 1; i <= pdf.numPages; i++) {
            if (fullText.length >= CHAR_LIMIT) break;

            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            
            // Extract and join text items
            const pageText = textContent.items.map((item: any) => item.str).join(' ');
            fullText += pageText + '\n\n';
        }

        // Sanitization: Remove excessive whitespace
        fullText = fullText.replace(/\s+/g, ' ').trim();

        // Enforce Limits
        if (fullText.length > CHAR_LIMIT) {
            fullText = fullText.substring(0, CHAR_LIMIT) + '... [TRUNCATED]';
        }

        return fullText;

    } catch (error) {
        console.error("PDF Extraction Failed:", error);
        throw new Error("Failed to parse PDF content.");
    }
};

const optimizeImage = (file: File): Promise<VisualAnchor> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const MAX_DIM = 512;
                let w = img.width;
                let h = img.height;

                // Scale down logic while preserving aspect ratio
                if (w > h) {
                    if (w > MAX_DIM) {
                        h *= MAX_DIM / w;
                        w = MAX_DIM;
                    }
                } else {
                    if (h > MAX_DIM) {
                        w *= MAX_DIM / h;
                        h = MAX_DIM;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error("Canvas context failed"));
                    return;
                }
                
                // Draw and optimize
                ctx.drawImage(img, 0, 0, w, h);
                
                // Export as JPEG with 0.8 quality to reduce token usage
                const mimeType = 'image/jpeg';
                const dataUrl = canvas.toDataURL(mimeType, 0.8);
                const base64 = dataUrl.split(',')[1];
                
                resolve({
                    mimeType,
                    data: base64
                });
            };
            img.onerror = () => reject(new Error("Failed to load image for optimization"));
            img.src = e.target?.result as string;
        };
        reader.onerror = () => reject(new Error("Failed to read image file"));
        reader.readAsDataURL(file);
    });
};

export const KnowledgeNode = memo(({ id, data }: NodeProps<PSDNodeData>) => {
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { unregisterNode } = useProceduralStore();

  // Cleanup on unmount
  useEffect(() => {
    return () => unregisterNode(id);
  }, [id, unregisterNode]);

  // Handle Drag Events
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const processFiles = useCallback((files: FileList | null) => {
    if (!files) return;

    const newStaged: StagedFile[] = [];
    const processingQueue: StagedFile[] = [];

    Array.from(files).forEach((file) => {
      // Validate types
      const isPdf = file.type === 'application/pdf';
      const isImage = file.type.startsWith('image/');

      if (isPdf || isImage) {
        const stagedId = `${file.name}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        
        const staged: StagedFile = {
          id: stagedId,
          file,
          type: isPdf ? 'pdf' : 'image',
          preview: isImage ? URL.createObjectURL(file) : undefined,
          status: 'parsing' // Start in parsing/optimizing state for both
        };
        
        newStaged.push(staged);
        processingQueue.push(staged);
      }
    });

    if (newStaged.length === 0) return;

    // 1. Update UI immediately
    setStagedFiles(prev => [...prev, ...newStaged]);

    // 2. Process Queue (PDFs & Images)
    processingQueue.forEach(async (item) => {
        try {
            if (item.type === 'pdf') {
                const text = await extractTextFromPdf(item.file);
                // Success Update for PDF
                setStagedFiles(prev => prev.map(f => {
                    if (f.id === item.id) {
                        return { ...f, status: 'complete', extractedText: text };
                    }
                    return f;
                }));
            } else if (item.type === 'image') {
                const anchor = await optimizeImage(item.file);
                // Success Update for Image
                setStagedFiles(prev => prev.map(f => {
                    if (f.id === item.id) {
                        return { ...f, status: 'complete', visualAnchor: anchor };
                    }
                    return f;
                }));
            }
        } catch (err: any) {
            // Error Update
            setStagedFiles(prev => prev.map(f => {
                if (f.id === item.id) {
                    return { ...f, status: 'error', errorMsg: "Processing Failed" };
                }
                return f;
            }));
        }
    });
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    processFiles(e.dataTransfer.files);
  }, [processFiles]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    processFiles(e.target.files);
    // Reset input to allow re-selecting same file
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeFile = (fileId: string) => {
    setStagedFiles(prev => {
        const target = prev.find(f => f.id === fileId);
        if (target?.preview) URL.revokeObjectURL(target.preview);
        return prev.filter(f => f.id !== fileId);
    });
  };

  // Derived state for the Visual Anchor Gallery
  const completedVisualAnchors = stagedFiles.filter(f => f.type === 'image' && f.status === 'complete' && f.visualAnchor && f.preview);

  return (
    <div className="w-[300px] bg-slate-900 rounded-lg shadow-2xl border border-teal-500/50 font-sans flex flex-col overflow-hidden">
      
      {/* Header */}
      <div className="bg-teal-900/30 p-2 border-b border-teal-800 flex items-center justify-between shrink-0">
         <div className="flex items-center space-x-2">
           <div className="p-1.5 bg-teal-500/20 rounded-full border border-teal-500/50">
             <BrainCircuit className="w-4 h-4 text-teal-300" />
           </div>
           <div className="flex flex-col leading-none">
             <span className="text-sm font-bold text-teal-100">Project Brain</span>
             <span className="text-[9px] text-teal-400">Context Engine</span>
           </div>
         </div>
         <span className="text-[9px] text-teal-500/70 font-mono border border-teal-800 px-1 rounded bg-black/20">KNOWLEDGE</span>
      </div>

      {/* Body */}
      <div className="p-3 bg-slate-800 space-y-3">
        
        {/* Drop Zone */}
        <div 
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`
                group relative border-2 border-dashed rounded-lg p-4 flex flex-col items-center justify-center transition-all cursor-pointer
                ${isDragging ? 'border-teal-400 bg-teal-900/20' : 'border-slate-600 hover:border-teal-500/50 hover:bg-slate-700/50'}
            `}
        >
            <input 
                type="file" 
                multiple 
                accept=".pdf,image/png,image/jpeg,image/jpg" 
                ref={fileInputRef} 
                className="hidden" 
                onChange={handleFileSelect}
            />
            
            <UploadCloud className={`w-8 h-8 mb-2 transition-colors ${isDragging ? 'text-teal-400' : 'text-slate-500 group-hover:text-teal-300'}`} />
            <span className="text-xs text-slate-400 font-medium group-hover:text-slate-300 text-center">
                Drop Brand Manuals (PDF)<br/> or Mood Boards (Images)
            </span>
        </div>

        {/* Staged Assets List */}
        <div className="space-y-1 max-h-32 overflow-y-auto custom-scrollbar border-b border-slate-700/50 pb-2">
            {stagedFiles.length === 0 ? (
                <div className="text-[10px] text-slate-600 text-center italic py-2">
                    No knowledge assets staged.
                </div>
            ) : (
                stagedFiles.map(file => (
                    <div key={file.id} className="flex items-center justify-between p-2 bg-slate-900/50 border border-slate-700 rounded group hover:border-teal-500/30 transition-colors">
                        <div className="flex items-center space-x-2 overflow-hidden">
                            {/* Icon / Preview */}
                            {file.type === 'pdf' ? (
                                <FileText className="w-4 h-4 text-orange-400 shrink-0" />
                            ) : (
                                <div className="w-4 h-4 rounded bg-slate-800 overflow-hidden shrink-0 border border-slate-600">
                                    {file.preview ? (
                                        <img src={file.preview} alt="preview" className="w-full h-full object-cover" />
                                    ) : (
                                        <ImageIcon className="w-3 h-3 text-purple-400 m-0.5" />
                                    )}
                                </div>
                            )}

                            {/* Info */}
                            <div className="flex flex-col overflow-hidden min-w-[120px]">
                                <span className="text-[10px] text-slate-300 truncate font-medium" title={file.file.name}>
                                    {file.file.name}
                                </span>
                                <div className="flex items-center space-x-1">
                                    <span className="text-[8px] text-slate-500 uppercase tracking-wider">
                                        {file.type} • {(file.file.size / 1024).toFixed(0)}KB
                                    </span>
                                    {file.type === 'pdf' && file.extractedText && (
                                        <span className="text-[8px] text-teal-500 font-mono" title="Characters Extracted">
                                            [{file.extractedText.length} chars]
                                        </span>
                                    )}
                                    {file.type === 'image' && file.status === 'complete' && (
                                        <span className="text-[8px] text-teal-500 font-mono" title="Optimized">
                                            [OPT]
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                        
                        {/* Status / Actions */}
                        <div className="flex items-center space-x-2">
                            {/* Status Icons */}
                            {file.status === 'parsing' && (
                                <Loader2 className="w-3 h-3 text-teal-400 animate-spin" />
                            )}
                            {file.status === 'complete' && (
                                <CheckCircle2 className="w-3 h-3 text-teal-500" />
                            )}
                            {file.status === 'error' && (
                                <div title={file.errorMsg}>
                                    <AlertCircle className="w-3 h-3 text-red-400" />
                                </div>
                            )}

                            <button 
                                onClick={(e) => { e.stopPropagation(); removeFile(file.id); }}
                                className="text-slate-600 hover:text-red-400 p-1 rounded transition-colors opacity-0 group-hover:opacity-100"
                            >
                                <Trash2 className="w-3 h-3" />
                            </button>
                        </div>
                    </div>
                ))
            )}
        </div>

        {/* Visual Reference Anchors Gallery */}
        {completedVisualAnchors.length > 0 && (
            <div className="flex flex-col space-y-2">
                <div className="flex items-center justify-between">
                    <span className="text-[9px] uppercase text-teal-400 font-bold tracking-wider flex items-center gap-1">
                        <Layers className="w-3 h-3" /> Visual Reference Anchors
                    </span>
                    <span className="text-[9px] text-slate-500 font-mono">{completedVisualAnchors.length} Ready</span>
                </div>
                
                <div className="flex overflow-x-auto gap-2 pb-2 custom-scrollbar">
                    {completedVisualAnchors.map(file => (
                        <div key={file.id} className="relative group shrink-0 w-16 h-16 rounded border border-slate-700 bg-black/20 overflow-hidden shadow-sm hover:border-teal-500/50 transition-colors">
                            <img 
                                src={file.preview} 
                                alt="Visual Anchor" 
                                className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" 
                            />
                            {/* Overlay Badge */}
                            <div className="absolute top-0 right-0 bg-teal-500 text-white text-[7px] font-bold px-1 rounded-bl leading-none shadow-sm">
                                REF
                            </div>
                            {/* Remove Overlay */}
                            <button
                                onClick={(e) => { e.stopPropagation(); removeFile(file.id); }}
                                className="absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                                <X className="w-5 h-5 text-white/80 hover:text-white drop-shadow-md" />
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        )}
        
        {/* Distillation Status / Controls (Placeholder for Phase 3) */}
        {stagedFiles.length > 0 && (
            <div className="pt-2 border-t border-slate-700/50">
                 <button className="w-full py-1.5 bg-slate-700 text-slate-500 text-[10px] font-bold uppercase tracking-wider rounded cursor-not-allowed flex items-center justify-center space-x-2" disabled>
                     <BookOpen className="w-3 h-3" />
                     <span>Distill Knowledge (Coming Soon)</span>
                 </button>
            </div>
        )}

      </div>

      {/* Output Handle */}
      <Handle
        type="source"
        position={Position.Right}
        id="knowledge-out"
        className="!w-3 !h-3 !-right-1.5 !bg-teal-500 !border-2 !border-white transition-colors duration-300"
        style={{ top: '50%', transform: 'translateY(-50%)' }}
        title="Output: Global Knowledge Context"
      />
    </div>
  );
});