import { setPageFilesAsync } from '../../shared/getPageFiles'
import { assert, debugGlob } from '../utils'
import { getViteDevServer } from '../globalContext'
//import { pathToFileURL } from 'url'
import { ViteDevServer } from 'vite'

setPageFilesAsync(getPageFilesExports)

async function getPageFilesExports(): Promise<unknown> {
  const viteDevServer = getViteDevServer()
  if (viteDevServer) {
    const pageFilesExports = await dev(viteDevServer)
    debugGlob('Page files found: ', pageFilesExports)
    return pageFilesExports
  }
  //const pageFilesExports = await distAutoImporterDisabled()
  assert(false)
}

async function dev(viteDevServer: ViteDevServer) {
  assert(viteDevServer)
  const moduleExports = await viteDevServer.ssrLoadModule('virtual:vite-plugin-ssr:pageFiles:server')
  const pageFilesExports: unknown = (moduleExports as any).default || (moduleExports as any)
  assert(pageFilesExports)
  return pageFilesExports
}

/*
async function distAutoImporterDisabled(): Promise<unknown> {
}

async function dynamicImport(filePath: string): Promise<unknown> {
  return new Function('file', 'return import(file)')(pathToFileURL(filePath).href)
}
*/
