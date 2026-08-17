const configuration = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are not allowed.',
      from: {},
      to: { circular: true }
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphan modules not reachable from any entry point.',
      from: { orphan: true, pathNot: 'node_modules' },
      to: {}
    },
    {
      name: 'no-deprecated-core',
      severity: 'error',
      comment: 'Do not depend on deprecated Node.js core modules.',
      from: {},
      to: { dependencyTypes: ['core'], path: ['^(domain|punycode)$'] }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['node', 'import', 'require', 'default']
    }
  }
}

export default configuration
