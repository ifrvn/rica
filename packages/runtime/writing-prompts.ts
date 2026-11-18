export function containsWritingPrompt(content: string, ...prompts: (string | null | undefined)[]) {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
  const normalized = normalize(content)
  return prompts.some((prompt) => prompt?.split(/\r?\n/u).some((line) => {
    const instruction = normalize(line)
    return instruction && normalized.includes(instruction)
  }))
}
