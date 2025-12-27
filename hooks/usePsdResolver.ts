import { useCallback } from 'react';
import { SerializableLayer } from '../types';

export type ResolverStatus = 
  | 'RESOLVED' 
  | 'CASE_MISMATCH' 
  | 'MISSING_DESIGN_GROUP' 
  | 'EMPTY_GROUP' 
  | 'DATA_LOCKED' 
  | 'NO_NAME'
  | 'UNKNOWN_ERROR';

export interface ResolverResult {
  layer: SerializableLayer | null;
  status: ResolverStatus;
  message: string;
}

// Helper: Deep recursive search for a layer by name
// Returns the first match found in the tree (pre-order traversal)
const findLayerDeep = (tree: SerializableLayer[], targetName: string, caseSensitive: boolean): SerializableLayer | null => {
  for (const layer of tree) {
    const layerName = layer.name || '';
    const isMatch = caseSensitive 
      ? layerName === targetName 
      : layerName.toLowerCase() === targetName.toLowerCase();

    if (isMatch) {
      return layer;
    }

    // Recursive Step
    if (layer.children && layer.children.length > 0) {
      const foundInChildren = findLayerDeep(layer.children, targetName, caseSensitive);
      if (foundInChildren) {
        return foundInChildren;
      }
    }
  }
  return null;
};

/**
 * Hook to resolve a template container name to a matching design layer group.
 * 
 * Encapsulates the logic for:
 * 1. Stripping procedural prefixes (e.g., '!!SYMBOLS' -> 'SYMBOLS')
 * 2. Strict & Case-insensitive matching using DEEP RECURSION
 * 3. Hierarchy/Content validation
 */
export const usePsdResolver = () => {
  /**
   * Resolves a template name to a matching group in the design layer tree with diagnostic feedback.
   * 
   * @param templateName The name of the container/template (e.g. "!!SYMBOLS" or "SYMBOLS").
   * @param designTree The array of SerializableLayers from the PSD.
   * @returns ResolverResult object containing the layer (if found), status code, and message.
   */
  const resolveLayer = useCallback((templateName: string, designTree: SerializableLayer[] | null): ResolverResult => {
    // Check if design data is available (Rule 2: Data Locked)
    if (!designTree) {
      return { 
        status: 'DATA_LOCKED', 
        layer: null, 
        message: 'Waiting for layer data...' 
      };
    }

    if (!templateName) {
      return { 
        status: 'NO_NAME', 
        layer: null, 
        message: 'No container connected' 
      };
    }

    // 1. Strip procedural prefixes (Rule 1: Stripping)
    const cleanTargetName = templateName.replace(/^!+/, '').trim();
    
    if (!cleanTargetName) {
      return { 
        status: 'NO_NAME', 
        layer: null, 
        message: 'Invalid name' 
      };
    }

    // 2. Strict Deep Search (Priority 1)
    const strictMatch = findLayerDeep(designTree, cleanTargetName, true);
    
    if (strictMatch) {
       // Content Validation (Rule: Empty Group)
       if (!strictMatch.children || strictMatch.children.length === 0) {
           return { 
             status: 'EMPTY_GROUP', 
             layer: strictMatch, 
             message: 'Group is empty' 
           };
       }
       return { 
         status: 'RESOLVED', 
         layer: strictMatch, 
         message: `${strictMatch.children.length} Layers Found` 
       };
    }

    // 3. Loose Deep Search (Priority 2 - Fallback)
    // Note: We use cleanTargetName for loose search as well, ignoring case inside the helper.
    const looseMatch = findLayerDeep(designTree, cleanTargetName, false);
    
    if (looseMatch) {
       if (!looseMatch.children || looseMatch.children.length === 0) {
           return { 
             status: 'EMPTY_GROUP', 
             layer: looseMatch, 
             message: 'Empty (Case Mismatch)' 
           };
       }
       return { 
         status: 'CASE_MISMATCH', 
         layer: looseMatch, 
         message: 'Warning: Case Mismatch' 
       };
    }

    // 4. No match found
    return { 
      status: 'MISSING_DESIGN_GROUP', 
      layer: null, 
      message: `No group named "${cleanTargetName}"` 
    };
  }, []);

  return { resolveLayer };
};