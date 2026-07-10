// Reference mod catalog (profile-independent metadata — distinct from the
// versioned delta release in ../delta/manifest.ts). Same trust-boundary shape:
// a signed envelope (sha256 + Ed25519 sig) wraps an untrusted body until
// verify.ts clears it.

import type { InstallInstructions } from '../install/recipe'
import type { DeployCategory } from '../deploy/plan'

export interface CatalogModEntry {
  nexus_id: number
  name: string
  category: string // free-form browse/UI taxonomy (framework, performance, patch, …)
  subcategory?: string
  priority_order?: number
  required?: 0 | 1
  description?: string
  author?: string
  tags?: string[]
  size_mb?: number
  has_it_translation?: 0 | 1
  notes?: string
  conflicts_with?: number[] // nexus_ids
  requires?: number[] // nexus_ids
  // Automatic conflict-resolution metadata, consumed by computeDeployPlan when the
  // mod is deployed. `deployCategory` drives Rule 1 (a 'patch' overrides a 'texture');
  // `resolutionWeight` breaks same-class ties (4K=4000 beats 2K=2000). Distinct axis
  // from the free-form `category` above, which is only for browsing/grouping.
  deployCategory?: DeployCategory
  resolutionWeight?: number
  // Optional deterministic install recipe (FOMOD replacement). Travels inside the
  // SIGNED catalog, so it inherits the Ed25519 trust boundary; CatalogService
  // denormalizes it into mod_install_recipe on ingest.
  install?: InstallInstructions
}

export interface ModCatalog {
  catalog_version: number // monotonic, signed (anti-downgrade/replay)
  generated_at: string
  source: string
  mods: CatalogModEntry[]
}

export interface SignedCatalog {
  catalog: ModCatalog
  sha256: string
  sig_ed25519: string // hex, over canonicalJSON(catalog)
}

export type CatalogErrorKind =
  | 'parse'
  | 'schema'
  | 'integrity'
  | 'signature'
  | 'downgrade'
  | 'db'
  | 'network' // fetch layer: no connectivity, DNS, timeout, non-2xx, disallowed host/protocol

export interface CatalogIngestResult {
  success: boolean
  version?: number
  inserted?: number
  reused?: boolean
  error?: string
  errorKind?: CatalogErrorKind
}
