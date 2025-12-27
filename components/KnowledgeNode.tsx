import React, { memo, useCallback, useState, useEffect, useRef } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { useProceduralStore } from '../store/ProceduralContext';
import { PSDNodeData } from '../types';
import { BookOpen, Image as ImageIcon, FileText, Trash2, UploadCloud, BrainCircuit } from 'lucide-react';

interface StagedFile {
  id: string;
  file: File;
  type: 'pdf' | 'image';
  preview?: string;
}

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

    Array.from(files).forEach((file) => {
      // Validate types
      const isPdf = file.type === 'application/pdf';
      const isImage = file.type.startsWith('image/');

      if (isPdf || isImage) {
        const staged: StagedFile = {
          id: `${file.name}-${Date.now()}`,
          file,
          type: isPdf ? 'pdf' : 'image',
          preview: isImage ? URL.createObjectURL(file) : undefined
        };
        newStaged.push(staged);
      }
    });

    setStagedFiles(prev => [...prev, ...newStaged]);
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
        <div className="space-y-1 max-h-48 overflow-y-auto custom-scrollbar">
            {stagedFiles.length === 0 ? (
                <div className="text-[10px] text-slate-600 text-center italic py-2">
                    No knowledge assets staged.
                </div>
            ) : (
                stagedFiles.map(file => (
                    <div key={file.id} className="flex items-center justify-between p-2 bg-slate-900/50 border border-slate-700 rounded group hover:border-teal-500/30 transition-colors">
                        <div className="flex items-center space-x-2 overflow-hidden">
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
                            <div className="flex flex-col overflow-hidden">
                                <span className="text-[10px] text-slate-300 truncate font-medium" title={file.file.name}>
                                    {file.file.name}
                                </span>
                                <span className="text-[8px] text-slate-500 uppercase tracking-wider">
                                    {file.type} • {(file.file.size / 1024).toFixed(0)}KB
                                </span>
                            </div>
                        </div>
                        
                        <button 
                            onClick={(e) => { e.stopPropagation(); removeFile(file.id); }}
                            className="text-slate-600 hover:text-red-400 p-1 rounded transition-colors opacity-0 group-hover:opacity-100"
                        >
                            <Trash2 className="w-3 h-3" />
                        </button>
                    </div>
                ))
            )}
        </div>
        
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