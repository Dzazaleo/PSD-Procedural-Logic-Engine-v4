import React, { memo, useMemo, useEffect, useCallback, useState, useRef } from 'react';
import { Handle, Position, NodeProps, useEdges, useReactFlow, useNodes } from 'reactflow';
import { PSDNodeData, SerializableLayer, TransformedPayload, TransformedLayer, MAX_BOUNDARY_VIOLATION_PERCENT, LayoutStrategy } from '../types';
import { useProceduralStore } from '../store/ProceduralContext';
import { GoogleGenAI } from "@google/genai";
import { ChevronLeft, ChevronRight, History as HistoryIcon, Check, RefreshCw, RotateCcw } from 'lucide-react';

interface InstanceData {
  index: number;
  source: {
    ready: boolean;
    name?: string;
    nodeId?: string;
    handleId?: string; // Added to track specific source handle
    originalBounds?: any;
    layers?: any[];
    aiStrategy?: LayoutStrategy; // Metadata injection from upstream
    previewUrl?: string; // Draft from Analyst
    targetDimensions?: { w: number, h: number }; // Dimensions from Upstream Analyst
  };
  target: {
    ready: boolean;
    name?: string;
    bounds?: { x: number, y: number, w: number, h: number };
  };
  payload: TransformedPayload | null;
  strategyUsed?: boolean;
}

// --- SUB-COMPONENT: Generative Preview Overlay ---
interface OverlayProps {
    previewUrl?: string | null;
    history?: string[];
    activeHistoryIndex?: number;
    hasDraft?: boolean;
    isGenerating: boolean;
    scale: number;
    onConfirm: (url?: string) => void;
    onSeek: (direction: number) => void;
    canConfirm: boolean;
    isConfirmed: boolean;
    targetDimensions?: { w: number, h: number };
    sourceReference?: string;
    onImageLoad?: () => void; // Added for Optimistic UI Locking
    refinementPending?: boolean;
    generationId?: number; // Added to force update on new generation
}

const GenerativePreviewOverlay = ({ 
    previewUrl, 
    history = [],
    activeHistoryIndex,
    hasDraft,
    isGenerating,
    scale,
    onConfirm,
    onSeek,
    canConfirm,
    isConfirmed,
    targetDimensions,
    sourceReference,
    onImageLoad,
    refinementPending,
    generationId
}: OverlayProps) => {
    // Dynamic Ratio Calculation
    const { w, h } = targetDimensions || { w: 1, h: 1 };
    const ratio = w / h;
    const maxWidthStyle = `${240 * ratio}px`;
    
    // Calculate timeline bounds
    // Max Index = history.length if hasDraft, else history.length - 1
    const maxIndex = hasDraft ? history.length : Math.max(0, history.length - 1);
    const currentIndex = activeHistoryIndex !== undefined ? activeHistoryIndex : maxIndex;
    
    // Check if current view is the "Latest" (tip of the timeline)
    const isLatest = currentIndex === maxIndex;
    // Check if timeline has navigable history (any history items OR a draft exists)
    const hasHistory = history.length > 0 || hasDraft;

    // Use generationId in effect to force a repaint if needed, though React should handle prop changes
    useEffect(() => {
        // This effect serves as a marker that the overlay responds to generation updates
    }, [generationId]);

    return (
        <div className={`relative w-full mt-2 rounded-md overflow-hidden bg-slate-900/50 border transition-all duration-500 flex justify-center flex-col items-center ${isGenerating ? 'border-indigo-500/30' : 'border-purple-500/50'}`}>
             {/* Aspect Ratio Container */}
             <div 
                className="relative w-full flex items-center justify-center overflow-hidden group shadow-inner bg-black/20"
                style={{
                    aspectRatio: `${w} / ${h}`,
                    maxWidth: maxWidthStyle,
                    width: '100%'
                }}
             >
                 {/* Visual Grounding: Source Reference Thumbnail */}
                 {sourceReference && (
                     <div className="absolute top-2 left-2 z-20 flex flex-col items-start group/source pointer-events-none">
                        <div className="bg-black/60 backdrop-blur-md border border-white/20 p-0.5 rounded shadow-xl transition-transform transform group-hover/source:scale-150 origin-top-left">
                             <img 
                                src={sourceReference} 
                                alt="Style Source" 
                                className="w-8 h-8 object-cover rounded-[1px] border border-white/10" 
                             />
                        </div>
                        <span className="text-[7px] text-white/50 font-mono mt-1 bg-black/60 px-1 rounded border border-white/5 uppercase tracking-wider">
                            Source
                        </span>
                     </div>
                 )}
                 
                 {/* 1. The Ghost Image */}
                 {previewUrl ? (
                     <img 
                        src={previewUrl} 
                        onLoad={onImageLoad}
                        alt="AI Ghost" 
                        key={generationId} // Force remount on new generation for instant update
                        className={`w-full h-full object-cover transition-all duration-700 
                            ${isConfirmed 
                                ? 'opacity-100 grayscale-0 mix-blend-normal' 
                                : 'opacity-100 grayscale-0 mix-blend-normal' /* Remove ghosting opacity to allow clear evaluation */
                            }`}
                     />
                 ) : (
                     <div className="absolute inset-0 flex items-center justify-center z-0">
                         <div className="text-[9px] text-purple-400/50 font-mono text-center px-4 animate-pulse">
                             {isGenerating ? 'SYNTHESIZING GHOST...' : 'INITIALIZING PREVIEW...'}
                         </div>
                     </div>
                 )}

                 {/* 2. Scanning Line Animation (only during gen) */}
                 {isGenerating && (
                     <div className="absolute inset-0 z-20 pointer-events-none overflow-hidden">
                         <div className="absolute top-0 left-0 w-full h-[2px] bg-purple-400 shadow-[0_0_10px_rgba(168,85,247,0.8)] animate-scan-y"></div>
                     </div>
                 )}

                 {/* 3. Action Utility Bar (Top-Right, Unobstructed) */}
                 {previewUrl && (
                     <div className={`absolute top-2 right-2 z-40 flex flex-col items-end transition-opacity duration-300 ${!canConfirm && isLatest && isConfirmed ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}>
                        {(canConfirm || !isLatest || !isConfirmed) && (
                             <button 
                                onClick={(e) => { e.stopPropagation(); onConfirm(previewUrl); }}
                                className="bg-indigo-600/90 hover:bg-indigo-500 text-white p-1.5 rounded shadow-[0_4px_10px_rgba(0,0,0,0.3)] border border-white/20 transform hover:scale-105 active:scale-95 transition-all flex items-center space-x-1.5 backdrop-blur-[2px]"
                                title="Commit this generation to the pipeline"
                             >
                                <span className="text-[9px] font-bold uppercase tracking-wider leading-none">
                                    {!isLatest ? 'Restore' : refinementPending ? 'Update' : 'Confirm'}
                                </span>
                                {!isLatest ? (
                                    <RotateCcw className="w-3 h-3 text-indigo-100" />
                                ) : refinementPending ? (
                                    <RefreshCw className="w-3 h-3 text-indigo-100" />
                                ) : (
                                    <Check className="w-3 h-3 text-emerald-300" strokeWidth={3} />
                                )}
                             </button>
                        )}
                     </div>
                 )}

                 {/* 4. Status Badge (Bottom-Left) */}
                 <div className="absolute bottom-2 left-2 z-20 flex items-center space-x-2 pointer-events-none">
                     <span className={`text-[8px] px-1.5 py-0.5 rounded border backdrop-blur-sm shadow-[0_0_8px_rgba(0,0,0,0.5)]
                        ${isConfirmed && isLatest
                            ? 'bg-emerald-900/80 text-emerald-200 border-emerald-500/50' 
                            : 'bg-purple-900/80 text-purple-200 border-purple-500/50'
                        }`}>
                         {isConfirmed && isLatest ? 'CONFIRMED' : !isLatest ? `HISTORY ${currentIndex + 1}/${maxIndex + 1}` : 'PREVIEW'}
                     </span>
                     {isGenerating && (
                         <span className="flex h-1.5 w-1.5 relative">
                             <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
                             <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-purple-500"></span>
                         </span>
                     )}
                 </div>
             </div>
             
             {/* 5. History Controls (Bottom Bar) */}
             {hasHistory && (
                 <div className="w-full flex items-center justify-between px-2 py-1 bg-black/40 border-t border-white/5">
                     <button 
                         onClick={(e) => { e.stopPropagation(); onSeek(-1); }}
                         disabled={currentIndex === 0}
                         className={`p-1 rounded hover:bg-white/10 transition-colors ${currentIndex === 0 ? 'text-slate-600 cursor-not-allowed' : 'text-slate-300'}`}
                     >
                         <ChevronLeft size={12} />
                     </button>
                     
                     <div className="flex space-x-1">
                         {Array.from({ length: maxIndex + 1 }).map((_, i) => (
                             <div 
                                key={i} 
                                className={`w-1 h-1 rounded-full transition-colors ${i === currentIndex ? 'bg-purple-400' : 'bg-slate-600'}`}
                             />
                         ))}
                     </div>

                     <button 
                         onClick={(e) => { e.stopPropagation(); onSeek(1); }}
                         disabled={currentIndex === maxIndex}
                         className={`p-1 rounded hover:bg-white/10 transition-colors ${currentIndex === maxIndex ? 'text-slate-600 cursor-not-allowed' : 'text-slate-300'}`}
                     >
                         <ChevronRight size={12} />
                     </button>
                 </div>
             )}

             <style>{`
               @keyframes scan-y {
                 0% { top: 0%; opacity: 0; }
                 10% { opacity: 1; }
                 90% { opacity: 1; }
                 100% { top: 100%; opacity: 0; }
               }
               .animate-scan-y {
                 animation: scan-y 2.5s linear infinite;
               }
             `}</style>
        </div>
    );
};

export const RemapperNode = memo(({ id, data }: NodeProps<PSDNodeData>) => {
  // Read instance count from persistent data, default to 1 if new/undefined
  const instanceCount = data.instanceCount || 1;
  // SOFT LOCK STATE: Stores the PROMPT STRING that was confirmed
  const [confirmations, setConfirmations] = useState<Record<number, string>>({});
  
  // Local state for generated draft previews
  const [previews, setPreviews] = useState<Record<number, string>>({});
  const [isGeneratingPreview, setIsGeneratingPreview] = useState<Record<number, boolean>>({});
  
  // Track previous prompts to detect changes (In-Flight Logic)
  const lastPromptsRef = useRef<Record<number, string>>({});

  // Refs for current payload logic (used for sync update)
  const instancesRef = useRef<InstanceData[]>([]);

  // Blob Revocation Tracking
  const previousBlobsRef = useRef<Record<number, string>>({});

  // OPTIMISTIC UI STATE
  const [displayPreviews, setDisplayPreviews] = useState<Record<number, string>>({});
  const isTransitioningRef = useRef<Record<number, boolean>>({});

  const { setNodes } = useReactFlow();
  const edges = useEdges();
  const nodes = useNodes();
  
  // Consume data from Store
  const { templateRegistry, resolvedRegistry, payloadRegistry, registerPayload, updatePayload, seekHistory, unregisterNode } = useProceduralStore();

  // Cleanup
  useEffect(() => {
    return () => unregisterNode(id);
  }, [id, unregisterNode]);

  // Cleanup Revoked Blobs on Unmount
  useEffect(() => {
      const blobs = previousBlobsRef.current;
      return () => {
          Object.values(blobs).forEach(url => {
              if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
          });
      };
  }, []);

  // Handle Confirmation & Restoration
  // If `restoredUrl` is provided (from History Nav), we force it as current
  const handleConfirmGeneration = (index: number, prompt: string, restoredUrl?: string) => {
      setConfirmations(prev => ({ ...prev, [index]: prompt }));
      
      // CRITICAL FIX: Ensure the confirmed URL is also updated in local state so the 
      // subsequent registerPayload call sees the correct "source" for the payload.
      if (restoredUrl) {
          setPreviews(prev => ({ ...prev, [index]: restoredUrl }));
      }
  };

  const handleImageLoad = useCallback((index: number) => {
      isTransitioningRef.current[index] = false;
  }, []);

  // Compute Data for ALL Instances
  const instances: InstanceData[] = useMemo(() => {
    const result: InstanceData[] = [];
    const loadPsdNode = nodes.find(n => n.type === 'loadPsd');

    for (let i = 0; i < instanceCount; i++) {
        const sourceHandleId = `source-in-${i}`;
        const targetHandleId = `target-in-${i}`;

        // 1. Resolve Source
        let sourceData: any = { ready: false };
        const sourceEdge = edges.find(e => e.target === id && e.targetHandle === sourceHandleId);
        
        if (sourceEdge && sourceEdge.sourceHandle) {
             const resolvedData = resolvedRegistry[sourceEdge.source];
             if (resolvedData) {
                 const context = resolvedData[sourceEdge.sourceHandle];
                 if (context) {
                    const binarySourceId = loadPsdNode ? loadPsdNode.id : sourceEdge.source;
                    sourceData = {
                        ready: true,
                        name: context.container.containerName,
                        nodeId: binarySourceId,
                        sourceNodeId: sourceEdge.source,
                        handleId: sourceEdge.sourceHandle,
                        layers: context.layers,
                        originalBounds: context.container.bounds,
                        aiStrategy: context.aiStrategy,
                        previewUrl: context.previewUrl,
                        targetDimensions: context.targetDimensions
                    };
                 }
             }
        }

        // 2. Resolve Target
        let targetData: any = { ready: false };
        const targetEdge = edges.find(e => e.target === id && e.targetHandle === targetHandleId);

        if (targetEdge && targetEdge.sourceHandle) {
             const template = templateRegistry[targetEdge.source];
             if (template) {
                 const handle = targetEdge.sourceHandle;
                 let containerDefinition;
                 containerDefinition = template.containers.find(c => c.name === handle);
                 if (!containerDefinition && handle.startsWith('slot-bounds-')) {
                     const clean = handle.replace('slot-bounds-', '');
                     containerDefinition = template.containers.find(c => c.name === clean);
                 }
                 if (!containerDefinition) {
                     const indexMatch = handle.match(/^target-out-(\d+)$/);
                     if (indexMatch && template.containers[parseInt(indexMatch[1], 10)]) {
                         containerDefinition = template.containers[parseInt(indexMatch[1], 10)];
                     }
                 }
                 if (!containerDefinition && template.containers.length === 1) {
                     containerDefinition = template.containers[0];
                 }

                 if (containerDefinition) {
                     targetData = {
                         ready: true,
                         name: containerDefinition.originalName || containerDefinition.name,
                         bounds: containerDefinition.bounds
                     };
                 }
             }
        }

        // 3. Compute Payload
        let payload: TransformedPayload | null = null;
        let strategyUsed = false;

        if (sourceData.ready && targetData.ready) {
            const sourceRect = sourceData.originalBounds;
            const targetRect = targetData.bounds;
            
            const ratioX = targetRect.w / sourceRect.w;
            const ratioY = targetRect.h / sourceRect.h;
            let scale = Math.min(ratioX, ratioY);
            let anchorX = targetRect.x;
            let anchorY = targetRect.y;

            const strategy = sourceData.aiStrategy;
            
            if (strategy) {
                scale = strategy.suggestedScale;
                strategyUsed = true;
                const scaledW = sourceRect.w * scale;
                const scaledH = sourceRect.h * scale;
                anchorX = targetRect.x + (targetRect.w - scaledW) / 2;
                if (strategy.anchor === 'TOP') anchorY = targetRect.y;
                else if (strategy.anchor === 'BOTTOM') anchorY = targetRect.y + (targetRect.h - scaledH);
                else anchorY = targetRect.y + (targetRect.h - scaledH) / 2;
            } else {
                const scaledW = sourceRect.w * scale;
                const scaledH = sourceRect.h * scale;
                anchorX = targetRect.x + (targetRect.w - scaledW) / 2;
                anchorY = targetRect.y + (targetRect.h - scaledH) / 2;
            }

            const transformLayers = (layers: SerializableLayer[], parentDeltaX = 0, parentDeltaY = 0): TransformedLayer[] => {
              return layers.map(layer => {
                const relX = (layer.coords.x - sourceRect.x) / sourceRect.w;
                const relY = (layer.coords.y - sourceRect.y) / sourceRect.h;
                const geomX = anchorX + (relX * (sourceRect.w * scale));
                const geomY = anchorY + (relY * (sourceRect.h * scale));
                let finalX = geomX + parentDeltaX;
                let finalY = geomY + parentDeltaY;
                let layerScaleX = scale;
                let layerScaleY = scale;
                const override = strategy?.overrides?.find(o => o.layerId === layer.id);
                let currentDeltaX = parentDeltaX;
                let currentDeltaY = parentDeltaY;

                if (override) {
                   const aiX = targetRect.x + override.xOffset;
                   const aiY = targetRect.y + override.yOffset;
                   finalX = aiX;
                   finalY = aiY;
                   currentDeltaX = finalX - geomX;
                   currentDeltaY = finalY - geomY;
                   layerScaleX *= override.individualScale;
                   layerScaleY *= override.individualScale;
                }

                const bleedY = targetRect.h * MAX_BOUNDARY_VIOLATION_PERCENT;
                const minY = targetRect.y - bleedY;
                const maxY = targetRect.y + targetRect.h + bleedY;
                finalY = Math.max(minY, Math.min(finalY, maxY));
                const newW = layer.coords.w * layerScaleX;
                const newH = layer.coords.h * layerScaleY;

                return {
                  ...layer,
                  coords: { x: finalX, y: finalY, w: newW, h: newH },
                  transform: { scaleX: layerScaleX, scaleY: layerScaleY, offsetX: finalX, offsetY: finalY },
                  children: layer.children ? transformLayers(layer.children, currentDeltaX, currentDeltaY) : undefined
                };
              });
            };

            const transformedLayers = transformLayers(sourceData.layers as SerializableLayer[]);

            let requiresGeneration = false;
            let status: TransformedPayload['status'] = 'success';
            let generativePromptUsed = null;
            
            const currentPrompt = sourceData.aiStrategy?.generativePrompt;
            const confirmedPrompt = confirmations[i];
            const isConfirmed = !!currentPrompt && currentPrompt === confirmedPrompt;

            if (currentPrompt) {
                const scaleThreshold = 2.0;
                const isExplicit = sourceData.aiStrategy!.isExplicitIntent;
                const isHighStretch = scale > scaleThreshold;
                
                if (isConfirmed) {
                    requiresGeneration = true;
                    generativePromptUsed = currentPrompt;
                    status = 'success';
                } else if (isExplicit || isHighStretch) {
                    status = 'awaiting_confirmation';
                }
            }

            if (requiresGeneration && generativePromptUsed) {
                const genLayer: TransformedLayer = {
                    id: `gen-layer-${sourceData.name || 'unknown'}`,
                    name: `✨ AI Gen: ${generativePromptUsed.substring(0, 20)}...`,
                    type: 'generative',
                    isVisible: true,
                    opacity: 1,
                    coords: { x: targetRect.x, y: targetRect.y, w: targetRect.w, h: targetRect.h },
                    transform: { scaleX: 1, scaleY: 1, offsetX: targetRect.x, offsetY: targetRect.y },
                    generativePrompt: generativePromptUsed
                };
                transformedLayers.unshift(genLayer);
            }
            
            // STATE RECOVERY:
            // Fetch existing payload from store to preserve generation metadata (ID, History)
            // This prevents the sync effect from overwriting fresh generations with stale structure data.
            const storePayload = payloadRegistry[id]?.[`result-out-${i}`];

            payload = {
              status: status,
              sourceNodeId: sourceData.nodeId,
              sourceContainer: sourceData.name,
              targetContainer: targetData.name,
              layers: transformedLayers,
              scaleFactor: scale,
              metrics: { source: { w: sourceRect.w, h: sourceRect.h }, target: { w: targetRect.w, h: targetRect.h } },
              requiresGeneration: requiresGeneration,
              // Prioritize Store Payload > Local Previews
              previewUrl: storePayload?.previewUrl || previews[i] || sourceData.previewUrl,
              isConfirmed: isConfirmed,
              isTransient: !isConfirmed, 
              sourceReference: sourceData.aiStrategy?.sourceReference,
              // METADATA PRESERVATION:
              // Merge back key fields managed by the Store/Actions, not by this Calculator
              generationId: storePayload?.generationId,
              history: storePayload?.history,
              activeHistoryIndex: storePayload?.activeHistoryIndex,
              latestDraftUrl: storePayload?.latestDraftUrl,
              isSynthesizing: storePayload?.isSynthesizing
            };
        }

        result.push({
            index: i,
            source: sourceData,
            target: targetData,
            payload,
            strategyUsed
        });
    }

    return result;
  }, [instanceCount, edges, id, resolvedRegistry, templateRegistry, nodes, confirmations, previews, payloadRegistry]);

  // Keep Ref updated for synchronous access in async functions
  useEffect(() => {
      instancesRef.current = instances;
  }, [instances]);

  // Sync Payloads to Store (Standard update for non-generative changes)
  useEffect(() => {
    instances.forEach(instance => {
        // Only register if we aren't currently generating for this instance to avoid race conditions
        if (instance.payload && !isGeneratingPreview[instance.index]) {
            registerPayload(id, `result-out-${instance.index}`, instance.payload);
        }
    });
  }, [instances, id, registerPayload, isGeneratingPreview]);

  // GHOST FLUSHING
  useEffect(() => {
    let stateChanged = false;
    const nextPreviews = { ...previews };
    const nextConfirmations = { ...confirmations };

    instances.forEach(instance => {
        const strategyMethod = instance.source.aiStrategy?.method;
        const idx = instance.index;

        if (strategyMethod === 'GEOMETRIC') {
            if (nextPreviews[idx]) {
                delete nextPreviews[idx];
                stateChanged = true;
            }
            if (nextConfirmations[idx]) {
                delete nextConfirmations[idx];
                stateChanged = true;
            }
        }
    });

    if (stateChanged) {
        setPreviews(nextPreviews);
        setConfirmations(nextConfirmations);
    }
  }, [instances, previews, confirmations]);

  // OPTIMISTIC LOCK
  useEffect(() => {
    instances.forEach(instance => {
        const idx = instance.index;
        const incomingUrl = instance.payload?.previewUrl || previews[idx];
        const currentUrl = displayPreviews[idx];
        const isLocked = isTransitioningRef.current[idx];

        if (incomingUrl) {
             if (incomingUrl !== currentUrl) {
                 if (isLocked) return;
                 isTransitioningRef.current[idx] = true;
                 setDisplayPreviews(prev => ({ ...prev, [idx]: incomingUrl }));
                 setTimeout(() => {
                     if (isTransitioningRef.current[idx]) isTransitioningRef.current[idx] = false;
                 }, 800);
             }
        } else if (currentUrl) {
            setDisplayPreviews(prev => {
                const next = { ...prev };
                delete next[idx];
                return next;
            });
            isTransitioningRef.current[idx] = false;
        }
    });
  }, [instances, previews, displayPreviews]);

  // LAZY SYNTHESIS
  useEffect(() => {
    instances.forEach(instance => {
        const idx = instance.index;
        const strategy = instance.source.aiStrategy;
        const currentPrompt = strategy?.generativePrompt;
        
        const lastPrompt = lastPromptsRef.current[idx];
        const hasPrompt = !!currentPrompt;
        const promptChanged = hasPrompt && currentPrompt !== lastPrompt;
        
        const isAwaiting = instance.payload?.status === 'awaiting_confirmation';
        const hasPreview = !!(instance.payload?.previewUrl || previews[idx]);
        const needsInitialPreview = isAwaiting && hasPrompt && !hasPreview;

        if (promptChanged || needsInitialPreview) {
             if (isGeneratingPreview[idx] && !promptChanged) return;
             if (currentPrompt) lastPromptsRef.current[idx] = currentPrompt;

             const prompt = currentPrompt!;
             const sourceRef = instance.source.aiStrategy?.sourceReference;
             
             const generateDraft = async () => {
                 setIsGeneratingPreview(prev => ({...prev, [idx]: true}));
                 
                 // PHASE 1: FLUSH
                 updatePayload(id, `result-out-${idx}`, { isSynthesizing: true });

                 try {
                     const apiKey = process.env.API_KEY;
                     if (!apiKey) return;
                     const ai = new GoogleGenAI({ apiKey });
                     const parts: any[] = [];
                     if (sourceRef) {
                         const base64Data = sourceRef.includes('base64,') ? sourceRef.split('base64,')[1] : sourceRef;
                         parts.push({ inlineData: { mimeType: 'image/png', data: base64Data } });
                     }
                     parts.push({ text: prompt });

                     const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash-image',
                        contents: { parts },
                        config: { imageConfig: { aspectRatio: "1:1" } }
                     });
                     
                     let base64Data = null;
                     for (const part of response.candidates?.[0]?.content?.parts || []) {
                        if (part.inlineData) {
                            base64Data = part.inlineData.data;
                            break;
                        }
                     }
                     
                     if (base64Data) {
                         const url = `data:image/png;base64,${base64Data}`;
                         
                         // PHASE 2: FILL
                         // Removed local setPreviews() to rely strictly on Store round-trip for sync safety
                         
                         // Capture the previous blob for revocation *after* the DOM updates
                         const previousUrl = previousBlobsRef.current[idx];
                         if (previousUrl && previousUrl !== url && previousUrl.startsWith('blob:')) {
                             setTimeout(() => URL.revokeObjectURL(previousUrl), 2000);
                         }
                         previousBlobsRef.current[idx] = url;

                         // Dispatch new terminal state to store via updatePayload
                         updatePayload(id, `result-out-${idx}`, {
                             previewUrl: url,
                             isTransient: true,
                             isSynthesizing: false,
                             generationId: Date.now() // Atomic Stamp for Reconciliation
                         });
                     }

                 } catch (e) {
                     console.error("Draft Generation Failed", e);
                     // Error recovery: Reset synthesis flag
                     updatePayload(id, `result-out-${idx}`, { isSynthesizing: false });
                 } finally {
                     setIsGeneratingPreview(prev => ({...prev, [idx]: false}));
                 }
             };
             generateDraft();
        }
    });
  }, [instances, previews, isGeneratingPreview, id, updatePayload]);


  const addInstance = useCallback(() => {
    setNodes((nds) => nds.map((node) => {
        if (node.id === id) {
          return { ...node, data: { ...node.data, instanceCount: (node.data.instanceCount || 1) + 1 } };
        }
        return node;
    }));
  }, [id, setNodes]);

  return (
    <div className="min-w-[280px] bg-slate-800 rounded-lg shadow-xl border border-indigo-500/50 font-sans relative flex flex-col">
      <div className="bg-indigo-900/80 p-2 border-b border-indigo-800 flex items-center justify-between shrink-0 rounded-t-lg">
         <div className="flex items-center space-x-2">
           <svg className="w-4 h-4 text-indigo-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
             <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.384-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
           </svg>
           <span className="text-sm font-semibold text-indigo-100">Procedural Remapper</span>
         </div>
         <div className="flex flex-col items-end">
             <span className="text-[10px] text-indigo-400/70 font-mono">TRANSFORMER</span>
         </div>
      </div>

      <div className="flex flex-col">
          {instances.map((instance) => {
             const hasPreview = !!instance.payload?.previewUrl;
             const isAwaiting = instance.payload?.status === 'awaiting_confirmation';
             const currentPrompt = instance.source.aiStrategy?.generativePrompt;
             const confirmedPrompt = confirmations[instance.index];
             const isConfirmed = !!currentPrompt && currentPrompt === confirmedPrompt;
             const refinementPending = !!confirmedPrompt && !!currentPrompt && confirmedPrompt !== currentPrompt;
             const showOverlay = hasPreview || isAwaiting || refinementPending;

             // Fetch History directly from Store Payload (Source of Truth for Navigation)
             const storePayload = payloadRegistry[id]?.[`result-out-${instance.index}`];
             const history = storePayload?.history || [];
             const activeIndex = storePayload?.activeHistoryIndex;
             const latestDraft = storePayload?.latestDraftUrl;
             // The storePayload also holds the canonical confirmed URL which might differ from local calculation if navigation occurred
             const persistedPreview = storePayload?.previewUrl;
             const storeIsSynthesizing = storePayload?.isSynthesizing;

             // Prioritize Store Payload (if valid) > Optimistic Display > Instance Local > Draft
             const effectivePreview = persistedPreview || displayPreviews[instance.index] || instance.payload?.previewUrl || previews[instance.index];

             // Pass the CONFIRMED URL for the next iteration step (Soft-Lock Refinement)
             const iterativeSource = storePayload?.sourceReference || instance.payload?.sourceReference;
             
             // Consolidate synthesis state
             const isEffectiveGenerating = !!isGeneratingPreview[instance.index] || !!storeIsSynthesizing;

             return (
             <div key={instance.index} className="relative p-3 border-b border-slate-700/50 bg-slate-800 space-y-3 hover:bg-slate-700/20 transition-colors first:rounded-t-none">
                
                <div className="flex flex-col space-y-3">
                   <div className="relative flex items-center justify-between group">
                      <div className="flex flex-col w-full">
                          <div className="flex items-center justify-between mb-0.5">
                             <label className="text-[9px] uppercase text-slate-500 font-bold tracking-wider ml-1">Source Input</label>
                             {instance.source.ready && <span className="text-[8px] text-blue-400 font-mono">LINKED</span>}
                          </div>
                          
                          <div className={`relative text-xs px-3 py-1.5 rounded border transition-colors ${
                             instance.source.ready 
                               ? 'bg-indigo-900/30 border-indigo-500/30 text-indigo-200 shadow-sm' 
                               : 'bg-slate-900 border-slate-700 text-slate-500 italic'
                           }`}>
                             <Handle 
                                type="target" 
                                position={Position.Left} 
                                id={`source-in-${instance.index}`} 
                                className={`!w-3 !h-3 !-left-4 !border-2 z-50 transition-colors duration-200 ${
                                    instance.source.ready 
                                    ? '!bg-indigo-500 !border-white' 
                                    : '!bg-slate-700 !border-slate-500 group-hover:!bg-slate-600'
                                }`} 
                                style={{ top: '50%', transform: 'translateY(-50%)' }}
                                title={`Source for Instance ${instance.index}`}
                              />
                             {instance.source.ready ? instance.source.name : 'Connect Source...'}
                          </div>
                      </div>
                   </div>

                   <div className="relative flex items-center justify-between group">
                      <div className="flex flex-col w-full">
                          <div className="flex items-center justify-between mb-0.5">
                             <label className="text-[9px] uppercase text-slate-500 font-bold tracking-wider ml-1">Target Slot</label>
                             {instance.target.ready && <span className="text-[8px] text-emerald-400 font-mono">LINKED</span>}
                          </div>

                          <div className={`relative text-xs px-3 py-1.5 rounded border transition-colors ${
                             instance.target.ready 
                               ? 'bg-emerald-900/20 border-emerald-500/30 text-emerald-300 shadow-sm' 
                               : 'bg-slate-900 border-slate-700 text-slate-500 italic'
                           }`}>
                             <Handle 
                                type="target" 
                                position={Position.Left} 
                                id={`target-in-${instance.index}`} 
                                className={`!w-3 !h-3 !-left-4 !border-2 z-50 transition-colors duration-200 ${
                                    instance.target.ready 
                                    ? '!bg-emerald-500 !border-white' 
                                    : '!bg-slate-700 !border-slate-500 group-hover:!bg-slate-600'
                                }`} 
                                style={{ top: '50%', transform: 'translateY(-50%)' }}
                                title={`Target for Instance ${instance.index}`}
                              />
                             {instance.target.ready ? instance.target.name : 'Connect Target...'}
                          </div>
                      </div>
                   </div>
                </div>

                <div className="relative mt-2 pt-3 border-t border-slate-700/50 flex flex-col space-y-2">
                   {instance.payload ? (
                       <div className="flex flex-col w-full pr-4">
                           <div className="flex justify-between items-center">
                               <div className="flex items-center space-x-2">
                                   <span className="text-[10px] text-emerald-400 font-bold tracking-wide">READY</span>
                                   {instance.strategyUsed && (
                                       <span className="text-[8px] bg-pink-500/20 text-pink-300 px-1 rounded border border-pink-500/40">AI ENHANCED</span>
                                   )}
                                   {instance.payload.requiresGeneration && (
                                       <span className="text-[8px] bg-purple-500/20 text-purple-300 px-1 rounded border border-purple-500/40">GEN</span>
                                   )}
                               </div>
                               <span className="text-[10px] text-slate-400 font-mono">{instance.payload.scaleFactor.toFixed(2)}x Scale</span>
                           </div>
                           
                           <div className={`w-full h-1 rounded overflow-hidden mt-1 ${instance.strategyUsed ? 'bg-pink-900' : 'bg-slate-900'}`}>
                              <div className={`h-full ${instance.strategyUsed ? 'bg-pink-500' : 'bg-emerald-500'}`} style={{ width: '100%' }}></div>
                           </div>
                           
                           {showOverlay && (
                               <div className="mt-2 p-2 bg-slate-900/50 border border-slate-700 rounded flex flex-col space-y-2">
                                   {isAwaiting && (
                                        <span className="text-[9px] text-yellow-200 font-medium leading-tight">
                                            ⚠️ High procedural distortion.
                                        </span>
                                   )}
                                   {refinementPending && (
                                       <div className="flex items-center space-x-1.5 p-1.5 bg-indigo-900/40 border border-indigo-500/30 rounded mb-1 animate-pulse">
                                           <svg className="w-3 h-3 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                           <span className="text-[9px] text-indigo-200 font-medium leading-none">Refinement detected. Re-confirm to apply.</span>
                                       </div>
                                   )}
                                   
                                   <GenerativePreviewOverlay 
                                       previewUrl={effectivePreview}
                                       history={history}
                                       activeHistoryIndex={activeIndex}
                                       hasDraft={!!latestDraft}
                                       isGenerating={isEffectiveGenerating}
                                       scale={instance.payload.scaleFactor}
                                       onConfirm={(url) => handleConfirmGeneration(instance.index, instance.source.aiStrategy?.generativePrompt || '', url)}
                                       onSeek={(direction) => seekHistory(id, `result-out-${instance.index}`, direction)}
                                       canConfirm={isAwaiting || refinementPending}
                                       isConfirmed={isConfirmed}
                                       targetDimensions={instance.source.targetDimensions || instance.target.bounds}
                                       sourceReference={iterativeSource}
                                       onImageLoad={() => handleImageLoad(instance.index)}
                                       refinementPending={refinementPending}
                                       generationId={storePayload?.generationId}
                                   />
                               </div>
                           )}
                       </div>
                   ) : (
                       <div className="flex items-center space-x-2 opacity-50">
                           <svg className="w-3 h-3 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                           <span className="text-[10px] text-slate-500 italic">Waiting for connection...</span>
                       </div>
                   )}
                   
                   <Handle 
                      type="source" 
                      position={Position.Right} 
                      id={`result-out-${instance.index}`} 
                      className={`!w-3 !h-3 !-right-1.5 !border-2 transition-colors duration-300 z-50 ${
                          instance.payload && instance.payload.status !== 'error' 
                          ? '!bg-emerald-500 !border-white' 
                          : '!bg-slate-700 !border-slate-500'
                      }`} 
                      style={{ top: '50%', transform: 'translateY(-50%)' }}
                      title={`Output Payload ${instance.index}`} 
                   />
                </div>
             </div>
             );
          })}
      </div>

      <button 
        onClick={addInstance}
        className="w-full py-2 bg-slate-800 hover:bg-slate-700 border-t border-slate-700 text-slate-400 hover:text-slate-200 transition-colors flex items-center justify-center space-x-1 rounded-b-lg"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        <span className="text-[10px] font-medium uppercase tracking-wider">Add Remap Instance</span>
      </button>

    </div>
  );
});