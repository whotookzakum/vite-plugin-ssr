import { prerender as prerenderOriginal } from '../prerender'
import { assertWarning } from '../utils'
export const prerender: typeof prerenderOriginal = (options) => {
  assertWarning(
    false,
    "`import { prerender } from 'vite-plugin-ssr/cli'` is deprecated in favor of `import { prerender } from 'vite-plugin-ssr/prerender'``",
    { onlyOnce: true },
  )
  return prerenderOriginal(options)
}
