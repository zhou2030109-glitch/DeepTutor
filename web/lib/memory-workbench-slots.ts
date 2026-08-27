export const L3_WORKBENCH_SLOTS = ['recent', 'profile', 'scope', 'preferences'] as const

export type L3WorkbenchSlot = (typeof L3_WORKBENCH_SLOTS)[number]

export function isL3WorkbenchSlot(value: string): value is L3WorkbenchSlot {
  return (L3_WORKBENCH_SLOTS as readonly string[]).includes(value)
}

export function canConsolidateMemoryDoc(layer: 'L2' | 'L3', key: string): boolean {
  return !(layer === 'L3' && key === 'preferences')
}
