export interface OptionsRoute {
  tab: 'repos' | 'rules' | 'claude' | 'raw'
  repo?: string
  recruit?: boolean
  sub?: 'skills' | 'plugins' | 'mcp'
}

export declare function parseOptionsHash(hash: string): OptionsRoute | null
export declare function optionsHash(route: OptionsRoute | null | undefined): string

export declare function normFields(fields: Record<string, unknown>): Record<string, unknown>
export declare function isDirty(orig: string | Record<string, unknown>, fields: Record<string, unknown>): boolean

export interface DirtyItem {
  name: string
  dirty: boolean
}
export declare function dirtySummary(items: DirtyItem[]): string

export declare function forwardHash(moved: Record<string, string>, hash: string): string

export interface SearchEntry {
  kind: 'repo' | 'tag' | 'setting' | 'skill' | 'plugin' | 'mcp' | 'page'
  label: string
  detail: string
  hash: string
}

export interface SearchRepo {
  name: string
  tags?: string[]
  defaultBranch?: string
  image?: string
}

export interface SettingField {
  label: string
  help?: string
  name: string
}

export interface SearchClaude {
  skills?: Array<{ name: string; description?: string }>
  plugins?: Array<{ name: string; marketplace?: string; version?: string }>
  mcp?: Array<{ name: string; scope?: string; transport?: string }>
}

export declare function buildSearchIndex(input: {
  repos?: SearchRepo[]
  settingsFields?: SettingField[]
  claude?: SearchClaude
}): SearchEntry[]

export declare function searchOptions(index: SearchEntry[], query: string, limit?: number): SearchEntry[]
