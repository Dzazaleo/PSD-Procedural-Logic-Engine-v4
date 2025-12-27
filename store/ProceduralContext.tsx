import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { Psd } from 'ag-psd';
import { TemplateMetadata, MappingContext, TransformedPayload, LayoutStrategy, KnowledgeContext, KnowledgeRegistry } from '../types';

interface ProceduralState {
  // Maps NodeID -> Raw PSD Object (Binary/Structure)
  psdRegistry: Record<string, Psd>;
  
  // Maps NodeID -> Lightweight Template Metadata
  templateRegistry: Record<string, TemplateMetadata>;
  
  // Maps NodeID -> HandleID -> Resolved Context (Layers + Bounds)
  resolvedRegistry: Record<string, Record<string, MappingContext>>;

  // Maps NodeID -> HandleID -> Transformed Payload (Ready for Assembly)
  payloadRegistry: Record<string, Record<string, TransformedPayload>>;

  // Maps NodeID -> HandleID -> LayoutStrategy (AI Analysis)
  analysisRegistry: Record<string, Record<string, LayoutStrategy>>;

  // Maps NodeID -> KnowledgeContext (Global Design Rules)
  knowledgeRegistry: KnowledgeRegistry;

  // Global counter to force re-evaluation of downstream nodes upon binary re-hydration
  globalVersion: number;
}

interface ProceduralContextType extends ProceduralState {
  registerPsd: (nodeId: string, psd: Psd) => void;
  registerTemplate: (nodeId: string, template: TemplateMetadata) => void;
  registerResolved: (nodeId: string, handleId: string, context: MappingContext) => void;
  registerPayload: (nodeId: string, handleId: string, payload: TransformedPayload, masterOverride?: boolean) => void;
  updatePayload: (nodeId: string, handleId: string, partial: Partial<TransformedPayload>) => void; 
  registerAnalysis: (nodeId: string, handleId: string, strategy: LayoutStrategy) => void;
  registerKnowledge: (nodeId: string, context: KnowledgeContext) => void;
  updatePreview: (nodeId: string, handleId: string, url: string) => void;
  seekHistory: (nodeId: string, handleId: string, direction: number) => void; 
  unregisterNode: (nodeId: string) => void;
  triggerGlobalRefresh: () => void;
}

const ProceduralContext = createContext<ProceduralContextType | null>(null);

// --- HELPER: Reconcile Terminal State ---
// Implements "Double-Buffer" Update Strategy + Stale Guard + Geometric Preservation + History Loop + Logic Gate
const reconcileTerminalState = (
    incomingPayload: TransformedPayload, 
    currentPayload: TransformedPayload | undefined
): TransformedPayload => {

    // 0. GENERATIVE LOGIC GATE: HARD STOP
    // If generation is explicitly disallowed (per-instance toggle), we must strip all generative assets immediately.
    // This acts as a "Kill Switch" for the pipeline's specific instance.
    if (incomingPayload.generationAllowed === false) {
        return {
            ...incomingPayload,
            // Destructive Strip:
            previewUrl: undefined,
            history: [],
            activeHistoryIndex: 0,
            isConfirmed: false,
            isTransient: false,
            isSynthesizing: false,
            requiresGeneration: false, // Ensure downstream nodes know generation is off
            latestDraftUrl: undefined,
            // Preserve geometric data
            metrics: incomingPayload.metrics,
            // Visually remove any layers marked as generative
            layers: incomingPayload.layers.filter(l => l.type !== 'generative') 
        };
    }

    // 1. STALE GUARD:
    // If store has a newer generation ID than incoming, reject the update.
    if (currentPayload?.generationId && incomingPayload.generationId && incomingPayload.generationId < currentPayload.generationId) {
        return currentPayload;
    }

    // 2. SANITATION (Geometric Reset)
    // Explicitly flush preview and history if status is 'idle' (e.g. disconnected or reset)
    if (incomingPayload.status === 'idle') {
        return {
             ...incomingPayload,
             previewUrl: undefined,
             history: [],
             activeHistoryIndex: 0,
             isConfirmed: false,
             isTransient: false,
             isSynthesizing: false
        };
    }

    // 3. FLUSH PHASE (Start Synthesis)
    if (incomingPayload.isSynthesizing) {
        return {
            ...(currentPayload || incomingPayload),
            isSynthesizing: true,
            // Preserve visual context during load
            previewUrl: currentPayload?.previewUrl,
            history: currentPayload?.history || [],
            sourceReference: incomingPayload.sourceReference || currentPayload?.sourceReference,
            targetContainer: incomingPayload.targetContainer || currentPayload?.targetContainer || '',
            metrics: incomingPayload.metrics || currentPayload?.metrics,
            generationId: currentPayload?.generationId,
            generationAllowed: true
        };
    }

    // 4. HISTORY ACCUMULATION & FILL PHASE
    let nextHistory = currentPayload?.history || [];
    const currentUrl = currentPayload?.previewUrl;
    const incomingUrl = incomingPayload.previewUrl;

    // Detect if we have a new valid image that warrants a history entry
    const isNewImage = incomingUrl && incomingUrl !== currentUrl;
    
    if (isNewImage) {
        if (currentUrl) {
            // Push previous state to history
            // Deduplicate: only push if strictly different from last history item
            const lastItem = nextHistory.length > 0 ? nextHistory[nextHistory.length - 1] : null;
            if (lastItem !== currentUrl) {
                nextHistory = [...nextHistory, currentUrl];
            }
            // Buffer Limit: Keep last 5
            if (nextHistory.length > 5) {
                nextHistory = nextHistory.slice(-5);
            }
        }
    }

    // 5. REFINEMENT PERSISTENCE (State Guard)
    // Prevent accidental reset of confirmation if prompt hasn't changed structurally
    let isConfirmed = incomingPayload.isConfirmed ?? currentPayload?.isConfirmed ?? false;
    
    // If explicitly marked transient (draft), it cannot be confirmed yet
    if (incomingPayload.isTransient) {
        isConfirmed = false;
    }

    // 6. GEOMETRIC PRESERVATION
    // If this is a layout update (no generationId) but we have AI assets, keep them.
    if (!incomingPayload.generationId && currentPayload?.generationId) {
         return {
            ...incomingPayload,
            previewUrl: currentPayload.previewUrl,
            history: currentPayload.history,
            activeHistoryIndex: currentPayload.activeHistoryIndex,
            latestDraftUrl: currentPayload.latestDraftUrl,
            generationId: currentPayload.generationId,
            isSynthesizing: currentPayload.isSynthesizing,
            isConfirmed: currentPayload.isConfirmed, 
            isTransient: currentPayload.isTransient,
            sourceReference: currentPayload.sourceReference || incomingPayload.sourceReference,
            generationAllowed: true
         };
    }

    // 7. FINAL CONSTRUCTION
    return {
        ...incomingPayload,
        history: nextHistory,
        // Use incoming index if provided (navigation), else default to current view (latest)
        activeHistoryIndex: incomingPayload.activeHistoryIndex ?? nextHistory.length,
        isConfirmed,
        sourceReference: incomingPayload.sourceReference || currentPayload?.sourceReference,
        generationId: incomingPayload.generationId || currentPayload?.generationId,
        generationAllowed: true
    };
};

export const ProceduralStoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [psdRegistry, setPsdRegistry] = useState<Record<string, Psd>>({});
  const [templateRegistry, setTemplateRegistry] = useState<Record<string, TemplateMetadata>>({});
  const [resolvedRegistry, setResolvedRegistry] = useState<Record<string, Record<string, MappingContext>>>({});
  const [payloadRegistry, setPayloadRegistry] = useState<Record<string, Record<string, TransformedPayload>>>({});
  const [analysisRegistry, setAnalysisRegistry] = useState<Record<string, Record<string, LayoutStrategy>>>({});
  const [knowledgeRegistry, setKnowledgeRegistry] = useState<KnowledgeRegistry>({});
  const [globalVersion, setGlobalVersion] = useState<number>(0);

  const registerPsd = useCallback((nodeId: string, psd: Psd) => {
    setPsdRegistry(prev => ({ ...prev, [nodeId]: psd }));
  }, []);

  const registerTemplate = useCallback((nodeId: string, template: TemplateMetadata) => {
    setTemplateRegistry(prev => {
      if (prev[nodeId] === template) return prev;
      if (JSON.stringify(prev[nodeId]) === JSON.stringify(template)) return prev;
      return { ...prev, [nodeId]: template };
    });
  }, []);

  const registerResolved = useCallback((nodeId: string, handleId: string, context: MappingContext) => {
    // SANITATION LOGIC (Ghost Flushing)
    let sanitizedContext = context;

    // Check Logic Gate: Is generation permitted?
    // We check specifically if allowed is FALSE. Undefined implies allowed (default).
    // Or we can be strict. Let's assume explicit disablement is required to trigger stripping.
    const isGenerationDisallowed = context.generationAllowed === false || context.aiStrategy?.generationAllowed === false;

    if (isGenerationDisallowed) {
        sanitizedContext = {
            ...context,
            // Flush Ghost Preview
            previewUrl: undefined,
            // Flush Generative Intent
            aiStrategy: context.aiStrategy ? {
                ...context.aiStrategy,
                generativePrompt: '',
                generationAllowed: false
            } : undefined,
            generationAllowed: false
        };
    } else if (context.aiStrategy?.method === 'GEOMETRIC') {
        sanitizedContext = {
            ...context,
            // Flush Ghost Preview
            previewUrl: undefined,
            // Flush Generative Intent
            aiStrategy: {
                ...context.aiStrategy,
                generativePrompt: ''
            }
        };
    }

    setResolvedRegistry(prev => {
      const nodeRecord = prev[nodeId] || {};
      const currentContext = nodeRecord[handleId];
      if (currentContext === sanitizedContext) return prev;
      if (currentContext && JSON.stringify(currentContext) === JSON.stringify(sanitizedContext)) return prev;
      
      return {
        ...prev,
        [nodeId]: {
          ...nodeRecord,
          [handleId]: sanitizedContext
        }
      };
    });
  }, []);

  const registerPayload = useCallback((nodeId: string, handleId: string, payload: TransformedPayload, masterOverride?: boolean) => {
    setPayloadRegistry(prev => {
      const nodeRecord = prev[nodeId] || {};
      const currentPayload = nodeRecord[handleId];
      
      let effectivePayload = { ...payload };

      // Phase 4A: Cascaded Generation Blocking (Master Override)
      // If the master gate is explicitly CLOSED (false), we enforce it immediately on the registry logic.
      if (masterOverride === false) {
          effectivePayload.generationAllowed = false;
          // Note: setting generationAllowed=false triggers the cleanup logic inside reconcileTerminalState
      }

      // APPLY RECONCILIATION MIDDLEWARE
      // This enforces logic gates, history, and state transitions
      const reconciledPayload = reconcileTerminalState(effectivePayload, currentPayload);

      // Deep equality check optimization
      if (currentPayload && JSON.stringify(currentPayload) === JSON.stringify(reconciledPayload)) {
          return prev;
      }

      // CHECK FOR NON-BILLABLE DRAFT REFRESH (Event Emission)
      if (currentPayload) {
          const isPreviewChanged = currentPayload.previewUrl !== reconciledPayload.previewUrl;
          const isStructureStable = 
              currentPayload.status === reconciledPayload.status &&
              currentPayload.requiresGeneration === reconciledPayload.requiresGeneration;

          if (isPreviewChanged && isStructureStable) {
               const event = new CustomEvent('payload-updated', { 
                   detail: { 
                       nodeId, 
                       handleId, 
                       type: 'DRAFT_REFRESH',
                       isBillable: false,
                       newPreviewUrl: reconciledPayload.previewUrl
                   } 
               });
               setTimeout(() => window.dispatchEvent(event), 0);
          }
      }

      return { 
        ...prev, 
        [nodeId]: {
            ...nodeRecord,
            [handleId]: reconciledPayload
        } 
      };
    });
  }, []);

  // NEW: Atomic Partial Update to prevent Stale Closures
  const updatePayload = useCallback((nodeId: string, handleId: string, partial: Partial<TransformedPayload>) => {
    setPayloadRegistry(prev => {
      const nodeRecord = prev[nodeId] || {};
      const currentPayload = nodeRecord[handleId];
      
      // Safety: Cannot update non-existent payload unless sufficient data provided (assumed handled upstream)
      if (!currentPayload && !partial.sourceContainer && !partial.previewUrl) return prev; 

      // Merge: State = Current + Partial
      const mergedPayload: TransformedPayload = currentPayload 
        ? { ...currentPayload, ...partial }
        : (partial as TransformedPayload); 

      // Reconcile
      const reconciledPayload = reconcileTerminalState(mergedPayload, currentPayload);
      
      if (currentPayload && JSON.stringify(currentPayload) === JSON.stringify(reconciledPayload)) return prev;

      return { 
        ...prev, 
        [nodeId]: {
            ...nodeRecord,
            [handleId]: reconciledPayload
        } 
      };
    });
  }, []);

  const registerAnalysis = useCallback((nodeId: string, handleId: string, strategy: LayoutStrategy) => {
    setAnalysisRegistry(prev => {
        const nodeRecord = prev[nodeId] || {};
        const currentStrategy = nodeRecord[handleId];
        
        if (currentStrategy === strategy) return prev;
        if (currentStrategy && JSON.stringify(currentStrategy) === JSON.stringify(strategy)) return prev;
        
        return { 
            ...prev, 
            [nodeId]: {
                ...nodeRecord,
                [handleId]: strategy
            } 
        };
    });
  }, []);

  const registerKnowledge = useCallback((nodeId: string, context: KnowledgeContext) => {
    setKnowledgeRegistry(prev => {
        if (prev[nodeId] === context) return prev;
        if (JSON.stringify(prev[nodeId]) === JSON.stringify(context)) return prev;
        return { ...prev, [nodeId]: context };
    });
  }, []);

  const updatePreview = useCallback((nodeId: string, handleId: string, url: string) => {
    setPayloadRegistry(prev => {
      const nodeRecord = prev[nodeId];
      if (!nodeRecord) return prev; 
      
      const currentPayload = nodeRecord[handleId];
      if (!currentPayload) return prev;

      if (currentPayload.previewUrl === url) return prev;

      return {
        ...prev,
        [nodeId]: {
          ...nodeRecord,
          [handleId]: {
            ...currentPayload,
            previewUrl: url
          }
        }
      };
    });
  }, []);

  const seekHistory = useCallback((nodeId: string, handleId: string, direction: number) => {
    setPayloadRegistry(prev => {
        const nodeRecord = prev[nodeId];
        if (!nodeRecord) return prev;
        const payload = nodeRecord[handleId];
        if (!payload) return prev;
        
        const history = payload.history || [];
        const maxIndex = history.length;
        
        const currentIndex = payload.activeHistoryIndex !== undefined ? payload.activeHistoryIndex : maxIndex;
        const nextIndex = Math.max(0, Math.min(currentIndex + direction, maxIndex));
        
        if (nextIndex === currentIndex) return prev;
        
        let viewUrl: string | undefined;
        let isConfirmed = payload.isConfirmed;

        if (nextIndex < history.length) {
            viewUrl = history[nextIndex];
            isConfirmed = false;
        } 
        
        if (!viewUrl && nextIndex === history.length) {
             return prev;
        }

        return {
            ...prev,
            [nodeId]: {
                ...nodeRecord,
                [handleId]: {
                    ...payload,
                    activeHistoryIndex: nextIndex,
                    previewUrl: viewUrl || payload.previewUrl,
                    isConfirmed: isConfirmed
                }
            }
        };
    });
  }, []);

  const unregisterNode = useCallback((nodeId: string) => {
    setPsdRegistry(prev => { const { [nodeId]: _, ...rest } = prev; return rest; });
    setTemplateRegistry(prev => { const { [nodeId]: _, ...rest } = prev; return rest; });
    setResolvedRegistry(prev => { const { [nodeId]: _, ...rest } = prev; return rest; });
    setPayloadRegistry(prev => { const { [nodeId]: _, ...rest } = prev; return rest; });
    setAnalysisRegistry(prev => { const { [nodeId]: _, ...rest } = prev; return rest; });
    setKnowledgeRegistry(prev => { const { [nodeId]: _, ...rest } = prev; return rest; });
    
    // Lifecycle Force Refresh: 
    // Increment global version to notify downstream subscribers (like Analyst Node) 
    // that a dependency (e.g., Knowledge Node) might have been removed.
    setGlobalVersion(v => v + 1);
  }, []);

  const triggerGlobalRefresh = useCallback(() => {
    setGlobalVersion(v => v + 1);
  }, []);

  const value = useMemo(() => ({
    psdRegistry,
    templateRegistry,
    resolvedRegistry,
    payloadRegistry,
    analysisRegistry,
    knowledgeRegistry,
    globalVersion,
    registerPsd,
    registerTemplate,
    registerResolved,
    registerPayload,
    updatePayload, 
    registerAnalysis,
    registerKnowledge,
    updatePreview,
    seekHistory,
    unregisterNode,
    triggerGlobalRefresh
  }), [
    psdRegistry, templateRegistry, resolvedRegistry, payloadRegistry, analysisRegistry, knowledgeRegistry, globalVersion,
    registerPsd, registerTemplate, registerResolved, registerPayload, updatePayload, registerAnalysis, registerKnowledge, updatePreview, seekHistory,
    unregisterNode, triggerGlobalRefresh
  ]);

  return (
    <ProceduralContext.Provider value={value}>
      {children}
    </ProceduralContext.Provider>
  );
};

export const useProceduralStore = () => {
  const context = useContext(ProceduralContext);
  if (!context) {
    throw new Error('useProceduralStore must be used within a ProceduralStoreProvider');
  }
  return context;
};