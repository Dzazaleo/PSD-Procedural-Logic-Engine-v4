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
  registerAnalysis: (nodeId: string, handleId: string, strategy: LayoutStrategy) => void;
  updatePreview: (nodeId: string, handleId: string, url: string) => void;
  seekHistory: (nodeId: string, handleId: string, direction: number) => void; 
  unregisterNode: (nodeId: string) => void;
  triggerGlobalRefresh: () => void;
}

const ProceduralContext = createContext<ProceduralContextType | null>(null);

// --- HELPER: Reconcile Terminal State ---
const reconcileTerminalState = (
    incomingPayload: TransformedPayload, 
    currentPayload: TransformedPayload | undefined
): TransformedPayload => {
    
    const existingHistory = currentPayload?.history || [];
    let nextHistory = existingHistory;
    let nextDraftUrl = currentPayload?.latestDraftUrl;
    let nextActiveIndex = currentPayload?.activeHistoryIndex;
    
    // Carry over history pointer if not explicitly reset, but default to 'tip' logic if undefined
    if (nextActiveIndex === undefined) nextActiveIndex = existingHistory.length > 0 ? existingHistory.length - 1 : 0;

    const isIncomingTerminal = incomingPayload.isConfirmed && !incomingPayload.isTransient;
    
    // Case 1: Transient Update (Ghost Generation)
    if (incomingPayload.isTransient) {
        nextDraftUrl = incomingPayload.previewUrl;
        // Point to the ghost (which effectively sits at 'length')
        nextActiveIndex = nextHistory.length;
        
        return {
            ...incomingPayload,
            history: nextHistory,
            activeHistoryIndex: nextActiveIndex,
            latestDraftUrl: nextDraftUrl
        };
    }
    
    // Case 2: Terminal Commit (User Confirmed)
    if (isIncomingTerminal) {
        const confirmedUrl = incomingPayload.previewUrl;

        // Atomic Commitment: Lock the URL into history
        if (confirmedUrl) {
            const lastHistory = existingHistory[existingHistory.length - 1];
            // Only push if it's new
            if (lastHistory !== confirmedUrl) {
                nextHistory = [...existingHistory, confirmedUrl].slice(-10);
            }
        }
        
        // Ghost is now canonical. Clear draft buffer.
        nextDraftUrl = undefined;
        // Point to the new canonical tip
        nextActiveIndex = nextHistory.length - 1;
        
        // ITERATIVE UPDATE: The confirmed payload becomes the new Source Reference for future refinements
        const nextSourceReference = confirmedUrl || incomingPayload.sourceReference;

        return {
            ...incomingPayload,
            // Ensure the persistent payload has the correct URL (Fixes Export Lookup)
            previewUrl: confirmedUrl, 
            history: nextHistory,
            activeHistoryIndex: nextActiveIndex,
            latestDraftUrl: nextDraftUrl,
            sourceReference: nextSourceReference, // Update reference for soft-lock refinement
            isTransient: false // Explicit sanitation
        };
    }
    
    // Fallback (Idle/Other): Preserve state logic
    return {
        ...incomingPayload,
        history: nextHistory,
        activeHistoryIndex: nextActiveIndex,
        latestDraftUrl: nextDraftUrl
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

      if (currentPayload === reconciledPayload) return prev;

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
    registerAnalysis,
    updatePreview,
    seekHistory,
    unregisterNode,
    triggerGlobalRefresh
  }), [
    psdRegistry, templateRegistry, resolvedRegistry, payloadRegistry, analysisRegistry, globalVersion,
    registerPsd, registerTemplate, registerResolved, registerPayload, registerAnalysis, updatePreview, seekHistory,
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