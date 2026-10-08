/**
 * Enforces the dependency rules of spec/15-code-architecture.md (ARCH-20).
 * A violation fails `pnpm lint:arch`, and therefore `pnpm check`.
 */
const NOT_TESTS = '\\.(spec|e2e-spec)\\.ts$';
const IPADDR = 'node_modules/ipaddr\\.js/';
const IO_CORE_MODULES =
  '^(node:)?(net|http|https|http2|tls|dgram|dns|dns/promises|fs|fs/promises|child_process|cluster|worker_threads)$';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'core-depends-on-nothing',
      comment: 'ARCH table: core imports no other area.',
      severity: 'error',
      from: { path: '^src/core/', pathNot: NOT_TESTS },
      to: { path: '^src/(features|adapters|platform|apps)/' },
    },
    {
      name: 'core-no-packages',
      comment: 'ARCH-10: core is pure; no npm packages (framework, DB/Redis clients...).',
      severity: 'error',
      from: { path: '^src/core/', pathNot: NOT_TESTS },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg', 'npm-unknown'],
        // Ngoại lệ duy nhất (spec/02 ARCH-24): ip-policy.ts dùng thư viện thuần ipaddr.js.
        pathNot: IPADDR,
      },
    },
    {
      name: 'core-ipaddr-only-in-ip-policy',
      comment: 'ARCH-24: ipaddr.js is allowed in core only for core/ip-policy.ts.',
      severity: 'error',
      from: { path: '^src/core/', pathNot: ['^src/core/ip-policy\\.ts$', NOT_TESTS] },
      to: { path: IPADDR },
    },
    {
      name: 'core-no-io-modules',
      comment: 'ARCH-10: core may use pure Node modules (e.g. node:crypto) but no I/O modules.',
      severity: 'error',
      from: { path: '^src/core/' },
      to: { dependencyTypes: ['core'], path: IO_CORE_MODULES },
    },
    {
      name: 'features-no-cross-feature',
      comment: 'ARCH-12: a feature never imports another feature; declare a port instead.',
      severity: 'error',
      from: { path: '^src/features/([^/]+)/' },
      to: { path: '^src/features/', pathNot: '^src/features/$1/' },
    },
    {
      name: 'features-no-adapters-or-apps',
      comment: 'ARCH table: features depend on ports, never on adapters or composition roots.',
      severity: 'error',
      from: { path: '^src/features/' },
      to: { path: '^src/(adapters|apps)/' },
    },
    {
      name: 'adapters-only-feature-ports',
      comment: 'ARCH table: adapters may import a feature only to implement its port (*.port.ts).',
      severity: 'error',
      from: { path: '^src/adapters/' },
      to: { path: '^src/features/', pathNot: '\\.port\\.ts$' },
    },
    {
      name: 'adapters-no-cross-technology-or-apps',
      comment: 'ARCH table: an adapter does not import another technology’s adapter or apps.',
      severity: 'error',
      from: { path: '^src/adapters/([^/]+)/' },
      to: { path: '^src/(adapters|apps)/', pathNot: '^src/adapters/$1/' },
    },
    {
      name: 'platform-no-business',
      comment: 'ARCH table: platform is technical only and imports no other area.',
      severity: 'error',
      from: { path: '^src/platform/', pathNot: '^src/platform/http/' },
      to: { path: '^src/(core|features|adapters|apps)/' },
    },
    {
      name: 'platform-http-no-other-areas',
      comment: 'D-20: platform/http imports no area except core types.',
      severity: 'error',
      from: { path: '^src/platform/http/' },
      to: { path: '^src/(features|adapters|apps)/' },
    },
    {
      name: 'platform-http-no-runtime-core',
      comment: 'D-20: imports from core inside platform/http must be `import type`.',
      severity: 'error',
      from: { path: '^src/platform/http/' },
      to: { path: '^src/core/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'apps-no-cross-app',
      comment: 'ARCH table: one process entrypoint never imports another; shared bootstrap helpers live at src/apps root.',
      severity: 'error',
      from: { path: '^src/apps/([^/]+)/' },
      to: { path: '^src/apps/[^/]+/', pathNot: '^src/apps/$1/' },
    },
    {
      name: 'framework-only-in-http-and-apps',
      comment: 'ARCH-11: NestJS may appear only in features/*/http, platform/http (D-20) and apps.',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/apps/', '^src/features/[^/]+/http/', '^src/platform/http/', NOT_TESTS] },
      to: { path: '@nestjs/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.json'],
    },
  },
};
