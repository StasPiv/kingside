import baseConfig from '/project/.worktrees/KS-1545/apps/web/vite.config.ts';

export default async function(env) {
  const resolved = typeof baseConfig === 'function' ? await baseConfig(env) : baseConfig;
  return {
    ...resolved,
    cacheDir: '/tmp/KS-1545/vite-cache',
  };
}
