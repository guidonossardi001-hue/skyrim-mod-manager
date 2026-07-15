import axios from 'axios'
import type { HttpGet } from '../install/downloadStream'
import type { HttpGetJson } from '../nexus/downloadLink'
import type { HttpPostJson } from '../nexus/collections'
import type { HttpGetText } from '../plugins/lootMasterlist'

// Adapt axios to the injectable HttpGet / HttpGetJson seams used by the resumable
// download stream core and the Nexus download_link resolver. The `as never` pair
// launders axios's over-broad config/response types onto the narrow injected shapes;
// kept in one place so that single unavoidable cast never gets copied around.
export const axiosGet: HttpGet = (url, cfg) => axios.get(url, cfg as never) as never
export const axiosJson: HttpGetJson = (url, cfg) => axios.get(url, cfg as never) as never
// POST variant for the Nexus GraphQL v2 endpoint (collections): body is JSON, response is JSON.
export const axiosPostJson: HttpPostJson = (url, body, cfg) => axios.post(url, body, cfg as never) as never
// Plain-text GET (LOOT masterlist.yaml): responseType 'text' so axios never tries to JSON-parse it.
export const axiosText: HttpGetText = (url, cfg) =>
  axios.get(url, { ...cfg, responseType: 'text' } as never) as never
