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
  updatePreview: (nodeId: string, handleId: string, url: string) => void; // New method for AI Ghosts
  unregisterNode: (nodeId: string) => void;
  triggerGlobalRefresh: () => void;
}

const ProceduralContext = createContext<ProceduralContextType | null>(null);

// --- HELPER: Reconcile Terminal State ---
// Handles the "Handshake" between the transient generative engine and the persistent history buffer.
// Logic:
// 1. If incoming payload is TRANSIENT (Ghost): Preserve existing history, update preview.
// 2. If incoming payload is TERMINAL (Confirmed): 
//    - Identify if the *previous* state was stable.
//    - Atomic Push: Bundle the previous stable state into history.
//    - Prune: Implicitly drops any previous transient states by not pushing them.
const reconcileTerminalState = (
    incomingPayload: TransformedPayload, 
    currentPayload: TransformedPayload | undefined
): TransformedPayload => {
    
    // 1. Establish Baseline History
    // If no current payload, history is empty. 
    // If current payload exists, grab its history buffer.
    const existingHistory = currentPayload?.history || [];
    
    // 2. Determine State Transition
    // Stable -> Stable (Refinement without intermediate ghost)
    // Stable -> Ghost (Drafting)
    // Ghost -> Stable (Confirmation)
    const isIncomingTerminal = incomingPayload.isConfirmed && !incomingPayload.isTransient;
    const wasPreviousStable = currentPayload && !currentPayload.isTransient && currentPayload.isConfirmed;
    
    let nextHistory = existingHistory;

    // 3. Atomic Push Logic
    // We only commit to history when we receive a verified Terminal State.
    // The item we commit is the *Previous Stable State* to allow Undo.
    // If we are just browsing ghosts (Transient), we do NOT touch history.
    if (isIncomingTerminal) {
        // Only push if the previous state was actually stable and different
        // This effectively "Prunes" any ghosts that happened in between, because we never pushed them.
        if (wasPreviousStable && currentPayload.previewUrl && currentPayload.previewUrl !== incomingPayload.previewUrl) {
             // Limit buffer size to 10
             nextHistory = [...existingHistory, currentPayload.previewUrl].slice(-10);
        }
    } else {
        // If incoming is Transient (Ghost), we maintain the *existing* history.
        // We do not push the ghost to history. 
        // We do not push the previous state yet (we wait for confirmation).
        nextHistory = existingHistory;
    }

    // 4. Return Reconciled Payload
    return {
        ...incomingPayload,
        history: nextHistory
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
               // EMIT EVENT: Notify listeners (RemapperNode UI) of a non-billable visual update.
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

      // Deep equality check
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
    unregisterNode,
    triggerGlobalRefresh
  }), [
    psdRegistry, templateRegistry, resolvedRegistry, payloadRegistry, analysisRegistry, globalVersion,
    registerPsd, registerTemplate, registerResolved, registerPayload, registerAnalysis, updatePreview,
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