import axios from 'axios'
import type { HttpGet } from '../install/downloadStream'
import type { HttpGetJson } from '../nexus/downloadLink'

// Adapt axios to the injectable HttpGet / HttpGetJson seams used by the resumable
// download stream core and the Nexus download_link resolver. The `as never` pair
// launders axios's over-broad config/response types onto the narrow injected shapes;
// kept in one place so that single unavoidable cast never gets copied around.
export const axiosGet: HttpGet = (url, cfg) => axios.get(url, cfg as never) as never
export const axiosJson: HttpGetJson = (url, cfg) => axios.get(url, cfg as never) as never
