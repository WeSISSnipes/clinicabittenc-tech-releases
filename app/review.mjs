// Provider contract: async suggest(original) -> { suggestions: [{start,end,before,after,reason}], doubts: [] }.
// No provider credentials, network calls, clinical inference or automatic application.
export class SimulatedProvider {
  async suggest(original) {
    const suggestions=[];
    const match=/ {2,}/.exec(original);
    if(match) suggestions.push({start:match.index,end:match.index+match[0].length,before:match[0],after:' ',reason:'Espaço duplicado (simulação local)'});
    return {suggestions,doubts:['Simulação: nenhuma avaliação clínica ou correção de reconhecimento de fala foi realizada.']};
  }
}
export function safeSuggestion(original,suggestion) {
  const {start,end,before,after}=suggestion;
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||original.slice(start,end)!==before) return false;
  // Intentionally stricter than a future language provider: only whitespace changes pass this simulated gate.
  return /^[ \t]+$/.test(before) && /^[ \t]+$/.test(after);
}
