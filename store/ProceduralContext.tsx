import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { Psd } from 'ag-psd';
import { TemplateMetadata, MappingContext, TransformedPayload, LayoutStrategy } from '../types';

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

  // Global counter to force re-evaluation of downstream nodes upon binary re-hydration
  globalVersion: number;
}

interface ProceduralContextType extends ProceduralState {
  registerPsd: (nodeId: string, psd: Psd) => void;
  registerTemplate: (nodeId: string, template: TemplateMetadata) => void;
  registerResolved: (nodeId: string, handleId: string, context: MappingContext) => void;
  registerPayload: (nodeId: string, handleId: string, payload: TransformedPayload) => void;
  updatePayload: (nodeId: string, handleId: string, partial: Partial<TransformedPayload>) => void; 
  registerAnalysis: (nodeId: string, handleId: string, strategy: LayoutStrategy) => void;
  updatePreview: (nodeId: string, handleId: string, url: string) => void;
  seekHistory: (nodeId: string, handleId: string, direction: number) => void; 
  unregisterNode: (nodeId: string) => void;
  triggerGlobalRefresh: () => void;
}

const ProceduralContext = createContext<ProceduralContextType | null>(null);

// --- HELPER: Reconcile Terminal State ---
// Implements "Double-Buffer" Update Strategy + Stale Guard + Geometric Preservation
const reconcileTerminalState = (
    incomingPayload: TransformedPayload, 
    currentPayload: TransformedPayload | undefined
): TransformedPayload => {

    // 1. STALE GUARD:
    // If store has a newer generation ID than incoming, reject the update.
    // This handles race conditions where a slow component render tries to save old data.
    if (currentPayload?.generationId && incomingPayload.generationId && incomingPayload.generationId < currentPayload.generationId) {
        return currentPayload;
    }

    // 2. GEOMETRIC PRESERVATION:
    // If incoming payload has NO generationId (it's a layout/geometry update from React Flow),
    // but the current payload HAS one (it's an AI result), preserve the AI visual state.
    if (!incomingPayload.generationId && currentPayload?.generationId) {
        return {
            ...incomingPayload, // Accept new geometry (x, y, w, h)
            // Restore Visual State from Store
            previewUrl: currentPayload.previewUrl,
            history: currentPayload.history,
            activeHistoryIndex: currentPayload.activeHistoryIndex,
            latestDraftUrl: currentPayload.latestDraftUrl,
            generationId: currentPayload.generationId,
            isSynthesizing: currentPayload.isSynthesizing,
            isConfirmed: currentPayload.isConfirmed, 
            isTransient: currentPayload.isTransient,
            sourceReference: currentPayload.sourceReference || incomingPayload.sourceReference
        };
    }

    // 3. FLUSH PHASE (Start Synthesis)
    if (incomingPayload.isSynthesizing) {
        return {
            ...(currentPayload || incomingPayload),
            isSynthesizing: true,
            sourceReference: incomingPayload.sourceReference || currentPayload?.sourceReference,
            targetContainer: incomingPayload.targetContainer || currentPayload?.targetContainer || '',
            metrics: incomingPayload.metrics || currentPayload?.metrics,
            generationId: currentPayload?.generationId // Keep ID valid during flush
        };
    }

    // 4. FILL PHASE (New Content Arrival)
    // Determine if this is a fresh generation
    const isNewGeneration = 
        !!incomingPayload.generationId && 
        (!currentPayload?.generationId || incomingPayload.generationId > currentPayload.generationId);

    const effectiveGenerationId = isNewGeneration ? incomingPayload.generationId : currentPayload?.generationId;

    if (isNewGeneration || (!currentPayload && incomingPayload.generationId)) {
        // Carry over history
        const nextHistory = currentPayload?.history || [];
        
        // If it's a transient draft, we don't push to history yet, just show it.
        // If confirmed, we push.
        
        // However, if we simply generated a new draft, current UI behavior treats 'latestDraftUrl' as the ghost.
        
        return {
            ...incomingPayload,
            history: nextHistory,
            // If new draft, index points to 'future' (length)
            activeHistoryIndex: incomingPayload.isTransient ? nextHistory.length : (nextHistory.length > 0 ? nextHistory.length - 1 : 0),
            latestDraftUrl: incomingPayload.isTransient ? incomingPayload.previewUrl : undefined,
            isSynthesizing: false,
            generationId: effectiveGenerationId
        };
    }

    // 5. TERMINAL COMMIT (User Confirmed)
    // If incoming is marked confirmed, we lock it into history.
    if (incomingPayload.isConfirmed && !incomingPayload.isTransient) {
        const existingHistory = currentPayload?.history || [];
        const confirmedUrl = incomingPayload.previewUrl;
        let nextHistory = existingHistory;

        if (confirmedUrl && existingHistory[existingHistory.length - 1] !== confirmedUrl) {
            nextHistory = [...existingHistory, confirmedUrl].slice(-10); // Keep last 10
        }

        return {
            ...incomingPayload,
            history: nextHistory,
            activeHistoryIndex: nextHistory.length - 1,
            latestDraftUrl: undefined, // Clear draft slot
            sourceReference: confirmedUrl, // Update Ref for next cycle
            isSynthesizing: false,
            generationId: effectiveGenerationId
        };
    }

    // Fallback: Merge updates normally
    return {
        ...incomingPayload,
        history: currentPayload?.history || [],
        activeHistoryIndex: currentPayload?.activeHistoryIndex,
        latestDraftUrl: currentPayload?.latestDraftUrl,
        generationId: effectiveGenerationId
    };
};

export const ProceduralStoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [psdRegistry, setPsdRegistry] = useState<Record<string, Psd>>({});
  const [templateRegistry, setTemplateRegistry] = useState<Record<string, TemplateMetadata>>({});
  const [resolvedRegistry, setResolvedRegistry] = useState<Record<string, Record<string, MappingContext>>>({});
  const [payloadRegistry, setPayloadRegistry] = useState<Record<string, Record<string, TransformedPayload>>>({});
  const [analysisRegistry, setAnalysisRegistry] = useState<Record<string, Record<string, LayoutStrategy>>>({});
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

    if (context.aiStrategy?.method === 'GEOMETRIC') {
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

  const registerPayload = useCallback((nodeId: string, handleId: string, payload: TransformedPayload) => {
    setPayloadRegistry(prev => {
      const nodeRecord = prev[nodeId] || {};
      const currentPayload = nodeRecord[handleId];

      // APPLY RECONCILIATION MIDDLEWARE
      const reconciledPayload = reconcileTerminalState(payload, currentPayload);

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
        const hasDraft = !!payload.latestDraftUrl;
        const maxIndex = hasDraft ? history.length : Math.max(0, history.length - 1);
        
        const currentIndex = payload.activeHistoryIndex !== undefined ? payload.activeHistoryIndex : maxIndex;
        const nextIndex = Math.max(0, Math.min(currentIndex + direction, maxIndex));
        
        if (nextIndex === currentIndex) return prev;
        
        // Resolve the View
        let viewUrl: string | undefined;
        if (nextIndex === history.length && hasDraft) {
            viewUrl = payload.latestDraftUrl;
        } else {
            viewUrl = history[nextIndex];
        }
        
        return {
            ...prev,
            [nodeId]: {
                ...nodeRecord,
                [handleId]: {
                    ...payload,
                    activeHistoryIndex: nextIndex,
                    previewUrl: viewUrl
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
    globalVersion,
    registerPsd,
    registerTemplate,
    registerResolved,
    registerPayload,
    updatePayload, 
    registerAnalysis,
    updatePreview,
    seekHistory,
    unregisterNode,
    triggerGlobalRefresh
  }), [
    psdRegistry, templateRegistry, resolvedRegistry, payloadRegistry, analysisRegistry, globalVersion,
    registerPsd, registerTemplate, registerResolved, registerPayload, updatePayload, registerAnalysis, updatePreview, seekHistory,
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