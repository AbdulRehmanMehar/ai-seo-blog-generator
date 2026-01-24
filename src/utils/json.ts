/**
 * Safely parse JSON, handling common LLM output issues like markdown fences
 * and trailing content after valid JSON.
 */
export function safeJsonParse(raw: string): unknown {
  let cleaned = raw.trim();
  
  // Remove markdown code fences if present
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();
  
  // Try to find JSON object or array boundaries
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  
  let start = -1;
  let isObject = false;
  
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace;
    isObject = true;
  } else if (firstBracket !== -1) {
    start = firstBracket;
    isObject = false;
  }
  
  if (start !== -1) {
    // Find matching closing bracket by counting nesting
    const openChar = isObject ? '{' : '[';
    const closeChar = isObject ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    
    for (let i = start; i < cleaned.length; i++) {
      const char = cleaned[i];
      
      if (escape) {
        escape = false;
        continue;
      }
      
      if (char === '\\' && inString) {
        escape = true;
        continue;
      }
      
      if (char === '"' && !escape) {
        inString = !inString;
        continue;
      }
      
      if (!inString) {
        if (char === openChar) {
          depth++;
        } else if (char === closeChar) {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
    }
    
    if (end !== -1) {
      cleaned = cleaned.slice(start, end + 1);
    }
  }
  
  return JSON.parse(cleaned);
}
