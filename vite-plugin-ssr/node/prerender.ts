import './page-files/setup'
import path, { join, sep, dirname, isAbsolute } from 'path'
import { isErrorPage, isStaticRoute, loadPageRoutes, route } from '../shared/route'
import {
  assert,
  assertUsage,
  assertWarning,
  hasProp,
  getFileUrl,
  isPlainObject,
  projectInfo,
  objectAssign,
  isObjectWithKeys,
  isCallable,
} from './utils'
import { loadPageFilesServer, prerenderPage, renderStatic404Page } from './renderPage'
import { blue, green, gray, cyan } from 'kolorist'
import pLimit from 'p-limit'
import { cpus } from 'os'
import { getPageFilesAllServerSide, PageFile } from '../shared/getPageFiles'
import { getGlobalContext, GlobalContext } from './globalContext'
import { resolveConfig } from 'vite'
import { assertVitePluginSsrConfig } from './plugin/plugins/config/VitePluginSsrConfig'

export { prerender }

type HtmlFile = {
  url: string
  pageContext: Record<string, unknown>
  htmlString: string
  pageContextSerialized: string | null
  doNotCreateExtraDirectory: boolean
  pageId: string | null
}

type DoNotPrerenderList = { pageId: string; pageServerFilePath: string }[]
type PrerenderedPageIds = Record<string, { url: string; _prerenderSourceFile: string | null }>

type GlobalPrerenderingContext = GlobalContext & {
  _allPageIds: string[]
  _pageFilesAll: PageFile[]
  _isPreRendering: true
  _usesClientRouter: boolean
  _noExtraDir: boolean
  prerenderPageContexts: PageContext[]
  _urlProcessor: null
}

type PageContext = GlobalPrerenderingContext & {
  url: string
  _prerenderSourceFile: string | null
  _pageContextAlreadyProvidedByPrerenderHook?: true
}

async function prerender({
  onPagePrerender,
  pageContextInit,
  configFile,
  ...deprecatedOptions
}: {
  onPagePrerender?: Function
  pageContextInit?: Record<string, unknown>
  configFile?: string
  /** @deprecated */
  root?: string
  /** @deprecated */
  partial?: boolean
  /** @deprecated */
  noExtraDir?: boolean
  /** @deprecated */
  outDir?: string
  /** @deprecated */
  base?: string
  /** @deprecated */
  parallel?: number
} = {}) {
  checkOutdatedOptions(deprecatedOptions)

  const logLevel = !!onPagePrerender ? 'warn' : 'info'

  if (logLevel === 'info') {
    console.log(`${cyan(`vite-plugin-ssr ${projectInfo.projectVersion}`)} ${green('pre-rendering HTML...')}`)
  }

  setProductionEnvVar()

  const viteConfig = await resolveConfig({ configFile }, 'vite-plugin-ssr prerender' as any, 'production')
  const outDir = 'dist/' // TODO
  const { root } = viteConfig
  assertUsage(
    viteConfig.configFile,
    `Could not find \`vite.config.js\` at ${root}. Use the option \`prerender({ configFile: 'path/to/vite.config.js' })\`.`,
  )
  assertUsage(
    viteConfig.plugins.some((p) => p.name?.startsWith('vite-plugin-ssr')),
    `The \`vite.config.js\` (${viteConfig.configFile}) does not contain vite-plugin-ssr. Make sure to add vite-plugin-ssr to \`vite.config.js\`, or, if you have more than one \`vite.config.js\`, use the option \`prerender({ configFile: 'path/to/vite.config.js' })\` to select the right \`vite.config.js\`.`,
  )
  assertVitePluginSsrConfig(viteConfig)
  const {
    partial = false,
    noExtraDir = false,
    parallel = cpus().length || 1,
  } = viteConfig.vitePluginSsr?.prerender ?? {}

  const concurrencyLimit = pLimit(parallel)

  const globalContext = await getGlobalContext(true)
  objectAssign(globalContext, {
    _isPreRendering: true as const,
    _urlProcessor: null,
    _noExtraDir: noExtraDir ?? false,
    _root: root,
    prerenderPageContexts: [] as PageContext[],
  })
  assert(globalContext._isProduction)
  objectAssign(globalContext, {
    _usesClientRouter: globalContext._manifestPlugin.usesClientRouter,
  })

  {
    const { pageFilesAll, allPageIds } = await getPageFilesAllServerSide(globalContext._isProduction)
    objectAssign(globalContext, {
      _pageFilesAll: pageFilesAll,
      _allPageIds: allPageIds,
    })
  }

  objectAssign(globalContext, pageContextInit)

  const doNotPrerenderList: DoNotPrerenderList = []

  await callPrerenderHooks(globalContext, doNotPrerenderList, concurrencyLimit)

  await handlePagesWithStaticRoutes(globalContext, doNotPrerenderList, concurrencyLimit)

  await callOnBeforePrerenderHook(globalContext)

  const prerenderPageIds: PrerenderedPageIds = {}
  const htmlFiles: HtmlFile[] = []
  await routeAndPrerender(globalContext, htmlFiles, prerenderPageIds, concurrencyLimit)

  warnContradictoryNoPrerenderList(prerenderPageIds, doNotPrerenderList)

  await prerender404Page(htmlFiles, globalContext)

  if (logLevel === 'info') {
    console.log(`${green(`✓`)} ${htmlFiles.length} HTML documents pre-rendered.`)
  }

  await Promise.all(
    htmlFiles.map((htmlFile) =>
      writeHtmlFile(htmlFile, root, outDir, doNotPrerenderList, concurrencyLimit, onPagePrerender, logLevel),
    ),
  )

  warnMissingPages(prerenderPageIds, doNotPrerenderList, globalContext, partial)
}

async function callPrerenderHooks(
  globalContext: GlobalPrerenderingContext,
  doNotPrerenderList: DoNotPrerenderList,
  concurrencyLimit: pLimit.Limit,
) {
  // Render URLs returned by `prerender()` hooks
  await Promise.all(
    globalContext._pageFilesAll
      .filter((p) => p.fileType === '.page.server')
      .map((p) =>
        concurrencyLimit(async () => {
          await p.loadFile?.()
          if (p.fileExports?.doNotPrerender) {
            doNotPrerenderList.push({ pageId: p.pageId, pageServerFilePath: p.filePath })
            return
          }

          const prerender = p.fileExports?.prerender
          if (!prerender) return
          assertUsage(isCallable(prerender), `\`export { prerender }\` of ${p.filePath} should be a function.`)
          const prerenderSourceFile = p.filePath
          assert(prerenderSourceFile)

          let prerenderResult: unknown
          try {
            prerenderResult = await prerender()
          } catch (err) {
            throwPrerenderError(err)
            assert(false)
          }
          const result = normalizePrerenderResult(prerenderResult, prerenderSourceFile)

          result.forEach(({ url, pageContext }) => {
            assert(typeof url === 'string')
            assert(url.startsWith('/'))
            assert(pageContext === null || isPlainObject(pageContext))
            let pageContextFound: PageContext | undefined = globalContext.prerenderPageContexts.find(
              (pageContext) => pageContext.url === url,
            )
            if (!pageContextFound) {
              pageContextFound = {
                ...globalContext,
                _prerenderSourceFile: prerenderSourceFile,
                url,
              }
              globalContext.prerenderPageContexts.push(pageContextFound)
            }
            if (pageContext) {
              objectAssign(pageContextFound, {
                _pageContextAlreadyProvidedByPrerenderHook: true,
                ...pageContext,
              })
            }
          })
        }),
      ),
  )
}

async function handlePagesWithStaticRoutes(
  globalContext: GlobalPrerenderingContext,
  doNotPrerenderList: DoNotPrerenderList,
  concurrencyLimit: pLimit.Limit,
) {
  // Pre-render pages with a static route
  const { pageRoutes } = await loadPageRoutes(globalContext)
  await Promise.all(
    pageRoutes.map((pageRoute) =>
      concurrencyLimit(async () => {
        const { pageId } = pageRoute

        if (doNotPrerenderList.find((p) => p.pageId === pageId)) {
          return
        }

        let url: string
        if (pageRoute.pageRouteFile) {
          const { routeValue } = pageRoute.pageRouteFile
          if (typeof routeValue === 'string' && isStaticRoute(routeValue)) {
            assert(routeValue.startsWith('/'))
            url = routeValue
          } else {
            // Abort since the page's route is a Route Function or parameterized Route String
            return
          }
        } else {
          url = pageRoute.filesystemRoute
        }
        assert(url.startsWith('/'))

        // Already included in a `prerender()` hook
        if (globalContext.prerenderPageContexts.find((pageContext) => pageContext.url === url)) {
          // Not sure if there is a use case for it, but why not allowing users to use a `prerender()` hook in order to provide some `pageContext` for a page with a static route
          return
        }

        const pageContext = {
          ...globalContext,
          _prerenderSourceFile: null,
          url,
          routeParams: {},
          _pageId: pageId,
        }
        objectAssign(pageContext, await loadPageFilesServer(pageContext))

        globalContext.prerenderPageContexts.push(pageContext)
      }),
    ),
  )
}

async function callOnBeforePrerenderHook(globalContext: {
  _pageFilesAll: PageFile[]
  prerenderPageContexts: PageContext[]
}) {
  const pageFilesServerDefault = globalContext._pageFilesAll.filter(
    (p) => p.fileType === '.page.server' && p.isDefaultPageFile,
  )
  await Promise.all(pageFilesServerDefault.map((p) => p.loadFile?.()))
  const hooks = pageFilesServerDefault
    .filter((p) => p.fileExports?.onBeforePrerender)
    .map((p) => ({ filePath: p.filePath, onBeforePrerender: p.fileExports!.onBeforePrerender }))
  if (hooks.length === 0) {
    return
  }
  assertUsage(
    hooks.length === 1,
    'There can be only one `onBeforePrerender()` hook. If you need to be able to define several, open a new GitHub issue.',
  )
  const hook = hooks[0]!
  const { onBeforePrerender, filePath } = hook
  assertUsage(isCallable(onBeforePrerender), `\`export { onBeforePrerender }\` of ${filePath} should be a function.`)
  const result = await onBeforePrerender(globalContext)
  if (result === null || result === undefined) {
    return
  }
  const errPrefix = `The \`onBeforePrerender()\` hook exported by \`${filePath}\``
  assertUsage(
    isObjectWithKeys(result, ['globalContext'] as const) && hasProp(result, 'globalContext'),
    `${errPrefix} should return \`null\`, \`undefined\`, or a plain JavaScript object \`{ globalContext: { /* ... */ } }\`.`,
  )
  const globalContextAddedum = result.globalContext
  assertUsage(
    isPlainObject(globalContextAddedum),
    `${errPrefix} returned \`{ globalContext }\` but \`globalContext\` should be a plain JavaScript object.`,
  )
  objectAssign(globalContext, globalContextAddedum)
}

async function routeAndPrerender(
  globalContext: GlobalPrerenderingContext & { prerenderPageContexts: PageContext[] },
  htmlFiles: HtmlFile[],
  prerenderPageIds: PrerenderedPageIds,
  concurrencyLimit: pLimit.Limit,
) {
  // Route all URLs
  await Promise.all(
    globalContext.prerenderPageContexts.map((pageContext) =>
      concurrencyLimit(async () => {
        const { url, _prerenderSourceFile: prerenderSourceFile } = pageContext
        const routeResult = await route(pageContext)
        if ('hookError' in routeResult) {
          throwPrerenderError(routeResult.hookError)
          assert(false)
        }
        assert(
          hasProp(routeResult.pageContextAddendum, '_pageId', 'null') ||
            hasProp(routeResult.pageContextAddendum, '_pageId', 'string'),
        )
        if (routeResult.pageContextAddendum._pageId === null) {
          // Is this assertion also true with a `onBeforeRoute()` hook?
          assert(prerenderSourceFile)
          assertUsage(
            false,
            `Your \`prerender()\` hook defined in \`${prerenderSourceFile}\ returns an URL \`${url}\` that doesn't match any page route. Make sure the URLs your return in your \`prerender()\` hooks always match the URL of a page.`,
          )
        }

        assert(routeResult.pageContextAddendum._pageId)
        objectAssign(pageContext, routeResult.pageContextAddendum)
        const { _pageId: pageId } = pageContext

        const pageFilesData = await loadPageFilesServer({
          ...globalContext,
          _pageId: pageId,
        })
        objectAssign(pageContext, pageFilesData)

        const { documentHtml, pageContextSerialized } = await prerenderPage(pageContext)
        htmlFiles.push({
          url,
          pageContext,
          htmlString: documentHtml,
          pageContextSerialized,
          doNotCreateExtraDirectory: globalContext._noExtraDir,
          pageId,
        })
        prerenderPageIds[pageId] = pageContext
      }),
    ),
  )
}

function warnContradictoryNoPrerenderList(
  prerenderPageIds: Record<string, { url: string; _prerenderSourceFile: string | null }>,
  doNotPrerenderList: DoNotPrerenderList,
) {
  Object.entries(prerenderPageIds).forEach(([pageId, { url, _prerenderSourceFile }]) => {
    const doNotPrerenderListHit = doNotPrerenderList.find((p) => p.pageId === pageId)
    if (doNotPrerenderListHit) {
      assert(_prerenderSourceFile)
      assertUsage(
        false,
        `Your \`prerender()\` hook defined in ${_prerenderSourceFile} returns the URL \`${url}\` which matches the page with \`${doNotPrerenderListHit?.pageServerFilePath}#doNotPrerender === true\`. This is contradictory: either do not set \`doNotPrerender\` or remove the URL from the list of URLs to be pre-rendered.`,
      )
    }
  })
}

function warnMissingPages(
  prerenderPageIds: Record<string, unknown>,
  doNotPrerenderList: DoNotPrerenderList,
  globalContext: { _allPageIds: string[] },
  partial: boolean,
) {
  globalContext._allPageIds
    .filter((pageId) => !prerenderPageIds[pageId])
    .filter((pageId) => !doNotPrerenderList.find((p) => p.pageId === pageId))
    .filter((pageId) => !isErrorPage(pageId))
    .forEach((pageId) => {
      assertWarning(
        partial,
        `Could not pre-render page \`${pageId}.page.*\` because it has a non-static route, and no \`prerender()\` hook returned (an) URL(s) matching the page's route. Either use a \`prerender()\` hook to pre-render the page, or use the \`--partial\` option to suppress this warning.`,
        { onlyOnce: true },
      )
    })
}

async function prerender404Page(htmlFiles: HtmlFile[], globalContext: GlobalPrerenderingContext) {
  if (!htmlFiles.find(({ url }) => url === '/404')) {
    const result = await renderStatic404Page(globalContext)
    if (result) {
      const url = '/404'
      const { documentHtml, pageContext } = result
      htmlFiles.push({
        url,
        pageContext,
        htmlString: documentHtml,
        pageContextSerialized: null,
        doNotCreateExtraDirectory: true,
        pageId: null,
      })
    }
  }
}

async function writeHtmlFile(
  { url, pageContext, htmlString, pageContextSerialized, doNotCreateExtraDirectory, pageId }: HtmlFile,
  root: string,
  outDir: string,
  doNotPrerenderList: DoNotPrerenderList,
  concurrencyLimit: pLimit.Limit,
  onPagePrerender: Function | undefined,
  logLevel: 'warn' | 'info',
) {
  assert(url.startsWith('/'))
  assert(!doNotPrerenderList.find((p) => p.pageId === pageId))

  const writeJobs = [
    write(
      url,
      pageContext,
      '.html',
      htmlString,
      root,
      outDir,
      doNotCreateExtraDirectory,
      concurrencyLimit,
      onPagePrerender,
      logLevel,
    ),
  ]
  if (pageContextSerialized !== null) {
    writeJobs.push(
      write(
        url,
        pageContext,
        '.pageContext.json',
        pageContextSerialized,
        root,
        outDir,
        doNotCreateExtraDirectory,
        concurrencyLimit,
        onPagePrerender,
        logLevel,
      ),
    )
  }
  await Promise.all(writeJobs)
}

function write(
  url: string,
  pageContext: Record<string, unknown>,
  fileExtension: '.html' | '.pageContext.json',
  fileContent: string,
  root: string,
  outDir: string,
  doNotCreateExtraDirectory: boolean,
  concurrencyLimit: pLimit.Limit,
  onPagePrerender: Function | undefined,
  logLevel: 'info' | 'warn',
) {
  return concurrencyLimit(async () => {
    const fileUrl = getFileUrl(url, fileExtension, fileExtension === '.pageContext.json' || doNotCreateExtraDirectory)
    assert(fileUrl.startsWith('/'))
    const filePathRelative = fileUrl.slice(1).split('/').join(sep)
    assert(!filePathRelative.startsWith(sep))
    assert(outDir && !outDir.includes('\\'), { outDir })
    const outDirPath = outDir.split('/')
    assert(!outDirPath.includes('server') && !outDirPath.includes('client'), { outDir })
    const filePath = join(root, outDir, 'client', filePathRelative)
    if (onPagePrerender) {
      objectAssign(pageContext, {
        _prerenderResult: {
          filePath,
          fileContent,
        },
      })
      await onPagePrerender(pageContext)
    } else {
      const { promises } = require('fs')
      const { writeFile, mkdir } = promises
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, fileContent)
      if (logLevel === 'info') {
        console.log(`${gray(path.posix.join(outDir, 'client/'))}${blue(filePathRelative)}`)
      }
    }
  })
}

function normalizePrerenderResult(
  prerenderResult: unknown,
  prerenderSourceFile: string,
): { url: string; pageContext: null | Record<string, unknown> }[] {
  if (Array.isArray(prerenderResult)) {
    return prerenderResult.map(normalize)
  } else {
    return [normalize(prerenderResult)]
  }

  function normalize(prerenderElement: unknown): { url: string; pageContext: null | Record<string, unknown> } {
    if (typeof prerenderElement === 'string') return { url: prerenderElement, pageContext: null }

    const errMsg1 = `The \`prerender()\` hook defined in \`${prerenderSourceFile}\` returned an invalid value`
    const errMsg2 =
      'Make sure your `prerender()` hook returns an object `{ url, pageContext }` or an array of such objects.'
    assertUsage(isPlainObject(prerenderElement), `${errMsg1}. ${errMsg2}`)
    assertUsage(hasProp(prerenderElement, 'url'), `${errMsg1}: \`url\` is missing. ${errMsg2}`)
    assertUsage(
      hasProp(prerenderElement, 'url', 'string'),
      `${errMsg1}: \`url\` should be a string (but we got \`typeof url === "${typeof prerenderElement.url}"\`).`,
    )
    assertUsage(
      prerenderElement.url.startsWith('/'),
      `${errMsg1}: the \`url\` with value \`${prerenderElement.url}\` doesn't start with \`/\`. Make sure each URL starts with \`/\`.`,
    )
    Object.keys(prerenderElement).forEach((key) => {
      assertUsage(key === 'url' || key === 'pageContext', `${errMsg1}: unexpected object key \`${key}\` ${errMsg2}`)
    })
    if (!hasProp(prerenderElement, 'pageContext')) {
      prerenderElement['pageContext'] = null
    }
    assertUsage(
      hasProp(prerenderElement, 'pageContext', 'object'),
      `The \`prerender()\` hook exported by ${prerenderSourceFile} returned an invalid \`pageContext\` value: make sure \`pageContext\` is a plain JavaScript object.`,
    )
    return prerenderElement
  }
}

function checkOutdatedOptions(options: {
  partial?: unknown
  noExtraDir?: unknown
  base?: unknown
  root?: unknown
  outDir?: unknown
  parallel?: number
}) {
  ;(['noExtraDir', 'partial', 'parallel'] as const).forEach((prop) => {
    assertUsage(
      options[prop] === undefined,
      `[prerender()] Option \`${prop}\` is deprecated. Define \`${prop}\` in \`vite.config.js\` instead. See https://vite-plugin-ssr.com/config`,
    )
  })
  ;(['base', 'root', 'outDir'] as const).forEach((prop) => {
    assertWarning(
      options[prop] === undefined,
      `[prerender()] Option \`${prop}\` is deprecated and has no effect (vite-plugin-ssr now automatically determines \`${prop}\`)`,
      {
        onlyOnce: true,
      },
    )
  })

  const { partial, noExtraDir, root, outDir, parallel } = options
  assertUsage(
    partial === undefined || partial === true || partial === false,
    '[prerender()] Option `partial` should be a boolean.',
  )
  assertUsage(
    noExtraDir === undefined || noExtraDir === true || noExtraDir === false,
    '[prerender()] Option `noExtraDir` should be a boolean.',
  )
  assertUsage(root === undefined || typeof root === 'string', '[prerender()] Option `root` should be a string.')
  assertUsage(
    root === undefined || isAbsolute(root),
    '[prerender()] The path `root` is not absolute. Make sure to provide an absolute path.',
  )
  assertUsage(outDir === undefined || typeof outDir === 'string', '[prerender()] Option `outDir` should be a string.')
  assertUsage(
    parallel === undefined || parallel,
    `[prerender()] Option \`parallel\` should be a number \`>=1\` but we got \`${parallel}\`.`,
  )
}

function setProductionEnvVar() {
  // The statement `process.env['NODE_ENV'] = 'production'` chokes webpack v4 (which Cloudflare Workers uses)
  const proc = process
  const { env } = proc
  env['NODE_ENV'] = 'production'
}

function throwPrerenderError(err: unknown) {
  if (hasProp(err, 'stack')) {
    throw err
  } else {
    throw new Error(err as any)
  }
}
