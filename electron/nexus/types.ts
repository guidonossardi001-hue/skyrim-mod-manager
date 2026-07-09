// Abstract Nexus Mods provider. The app is fully functional WITHOUT Nexus (a mock
// provider serves offline/demo data); when a real API key is supplied and
// NEXUS_ENABLED=true, the HTTP provider is selected automatically — no code change.

export interface NexusModMeta {
  mod_id: number
  name: string
  summary: string | null
  version: string | null
  author: string | null
  category: string | null
  endorsement: string | null
  updated_timestamp: number | null
  available: boolean
}

export interface NexusFile {
  file_id: number
  name: string
  version: string | null
  size: number
  category: string | null
}

export interface UpdateCheck {
  mod_id: number
  hasUpdate: boolean
  current: string | null
  latest: string | null
}

export interface NexusProvider {
  readonly kind: 'http' | 'mock'
  readonly enabled: boolean
  getMod(modId: number): Promise<NexusModMeta | null>
  searchByName(query: string): Promise<NexusModMeta[]>
  getFiles(modId: number): Promise<NexusFile[]>
  getLatestVersion(modId: number): Promise<string | null>
  checkUpdate(modId: number, currentVersion: string | null): Promise<UpdateCheck>
}
