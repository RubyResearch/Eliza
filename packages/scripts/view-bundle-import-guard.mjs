/**
 * View-bundle import guard.
 *
 * A plugin view bundle is built with `@elizaos/ui`, `react`, etc. left as
 * *external* bare imports (see `view-bundle-vite.config.ts`). At runtime the
 * shell's `DynamicViewLoader` does NOT load those bare specifiers directly —
 * the agent's bundle route wraps the bundle as a host-external factory
 * (`wrapBundleAsHostExternalFactory`), binding each external specifier to the
 * loader's `HOST_EXTERNAL_IMPORTERS` map so the view shares the host's
 * singletons.
 *
 * That binding is an EXACT-STRING match against the map's keys. The Vite build,
 * however, externalises by PREFIX (`@elizaos/ui` and anything under it). The two
 * therefore disagree: a view that imports an `@elizaos/ui/<subpath>` the loader
 * does not list is externalised by the build but never bound by the loader,
 * so the browser receives a bare `import … from "@elizaos/ui/<subpath>"` it
 * cannot resolve and the view fails to load with "Failed to resolve module
 * specifier".
 *
 * This guard closes that gap: it reads the loader's map (the single source of
 * truth) and asserts every bare import in every built view bundle is one the
 * loader can rewrite. Run at the end of `build-views.mjs` so a drift fails the
 * build instead of shipping a view that silently won't load.
 */

import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverViewBundleInventory } from "./lib/view-bundle-inventory.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const LOADER_PATH = path.join(
  repoRoot,
  "packages/ui/src/components/views/DynamicViewLoader.tsx",
);

// Build-variant entrypoints contribute plugin-owned host-external specifiers
// through `registerHostExternalImporter` (the loader's trunk map stays
// framework-only). These specifiers are just as loadable as the trunk ones, so
// the guard must union them into the allowed set. Any additional file that
// registers host externals must be listed here.
const HOST_EXTERNAL_REGISTRATION_PATHS = [
  {
    entryPath: path.join(repoRoot, "packages/app/src/main.tsx"),
    registrationPath: path.join(repoRoot, "packages/app/src/host-externals.ts"),
  },
];

// Relative imports are loader-private implementation paths, so their public
// specifier binding cannot be inferred from string equality. Keep the mapping
// exact: any new alias must identify the concrete module it exposes.
const LOADER_RELATIVE_IMPORT_BINDINGS = new Map([
  ["@elizaos/ui/api", "../../api/index.ts"],
  ["@elizaos/ui/api/csrf-client", "../../api/csrf-client.ts"],
  ["@elizaos/ui/config", "../../config/index.ts"],
  ["@elizaos/ui/events", "../../events/index.ts"],
  ["@elizaos/ui/hooks", "../../hooks/index.ts"],
  [
    "@elizaos/ui/hooks/runtime-capability-retry",
    "../../hooks/runtime-capability-retry.ts",
  ],
  [
    "@elizaos/ui/hooks/useActiveAgentAuthority",
    "../../hooks/useActiveAgentAuthority.ts",
  ],
  ["@elizaos/ui/layouts", "../../layouts/index.ts"],
  ["@elizaos/ui/platform", "../../platform/index.ts"],
  ["@elizaos/ui/platform/ios-runtime", "../../platform/ios-runtime.ts"],
  ["@elizaos/ui/spatial", "../../spatial/index.ts"],
  ["@elizaos/ui/state", "../../state/index.ts"],
  ["@elizaos/ui/state/useApp", "../../state/useApp.ts"],
  ["@elizaos/ui/utils", "../../utils/index.ts"],
  ["@elizaos/ui/hooks/resource-cache", "../../hooks/resource-cache.ts"],
  ["@elizaos/ui/utils/attachment-url", "../../utils/attachment-url.ts"],
  ["@elizaos/ui/utils/desktop-dialogs", "../../utils/desktop-dialogs.ts"],
  ["@elizaos/ui/utils/download-share", "../../utils/download-share.ts"],
  [
    "@elizaos/ui/components/composites/page-panel",
    "../composites/page-panel/index.ts",
  ],
  [
    "@elizaos/ui/components/composites/settings",
    "../composites/settings/index.ts",
  ],
  [
    "@elizaos/ui/components/shared/confirm-delete-control",
    "../shared/confirm-delete-control.tsx",
  ],
  ["@elizaos/ui/components/shared/SectionNav", "../shared/SectionNav.tsx"],
  ["@elizaos/ui/components/shared/ViewHeader", "../shared/ViewHeader.tsx"],
  [
    "@elizaos/ui/components/transcripts/TranscriptPlayer",
    "../transcripts/TranscriptPlayer.tsx",
  ],
  [
    "@elizaos/ui/components/transcripts/TranscriptsView",
    "../transcripts/TranscriptsView.tsx",
  ],
  [
    "@elizaos/ui/components/views/ShellViewAgentSurface",
    "./ShellViewAgentSurface.tsx",
  ],
  [
    "@elizaos/ui/components/composites/sidebar/sidebar-content",
    "../composites/sidebar/sidebar-content.tsx",
  ],
  [
    "@elizaos/ui/components/composites/sidebar/sidebar-panel",
    "../composites/sidebar/sidebar-panel.tsx",
  ],
  [
    "@elizaos/ui/components/composites/sidebar/sidebar-scroll-region",
    "../composites/sidebar/sidebar-scroll-region.tsx",
  ],
  [
    "@elizaos/ui/components/pages/MemoryDetailPanel",
    "../pages/MemoryDetailPanel.tsx",
  ],
  [
    "@elizaos/ui/components/pages/vector-browser-utils",
    "../pages/vector-browser-utils.ts",
  ],
  [
    "@elizaos/ui/components/shared/AppPageSidebar",
    "../shared/AppPageSidebar.tsx",
  ],
  ["@elizaos/ui/components/shared", "../shared/index.ts"],
  ["@elizaos/ui/components/ui/button", "../ui/button.tsx"],
  ["@elizaos/ui/components/ui/input", "../ui/input.tsx"],
  ["@elizaos/ui/components/ui/select", "../ui/select.tsx"],
  [
    "@elizaos/ui/components/ui/settings-controls",
    "../ui/settings-controls.tsx",
  ],
  ["@elizaos/ui/components/ui/spinner", "../ui/spinner.tsx"],
  ["@elizaos/ui/components/ui/skeleton-layouts", "../ui/skeleton-layouts.tsx"],
  ["@elizaos/ui/components/ui/tabs", "../ui/tabs.tsx"],
  ["@elizaos/ui/components/ui/textarea", "../ui/textarea.tsx"],
  ["@elizaos/ui/components/ui/tooltip-extended", "../ui/tooltip-extended.tsx"],
]);

// Compatibility importers assemble curated namespaces rather than importing a
// same-named package. Their function identities are therefore part of the
// loader contract and must not be interchangeable across map keys.
const LOADER_NAMED_IMPORTER_BINDINGS = new Map([
  ["@elizaos/app-core", "importAppCoreViewCompat"],
  ["@elizaos/app-core/browser", "importAppCoreViewCompat"],
  ["@elizaos/app-core/ui-compat", "importAppCoreViewCompat"],
  ["@elizaos/core", "importCoreViewCompat"],
  ["@elizaos/ui", "importUiRootCompat"],
  ["@elizaos/ui/app-navigate-view", "importUiAppNavigateViewCompat"],
  ["@elizaos/ui/bridge", "importUiBridgeCompat"],
  ["@elizaos/ui/components", "importUiComponentsCompat"],
]);

const LOADER_NAMESPACE_IMPORT_BINDINGS = new Map([
  ["@elizaos/ui/agent-surface", "../../agent-surface"],
]);

function parseSource(source, file, scriptKind) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  if (sourceFile.parseDiagnostics?.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    throw new Error(
      `[view-bundle-guard] ${file} is not parseable TypeScript: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
  }
  return sourceFile;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticPropertyName(property, file) {
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  if (
    ts.isComputedPropertyName(name) &&
    ts.isStringLiteralLike(name.expression)
  ) {
    return name.expression.text;
  }
  throw new Error(
    `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS in ${file} contains a non-static property`,
  );
}

function hasExportModifier(node) {
  return node.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function bindingIdentifiers(name, identifiers = []) {
  if (ts.isIdentifier(name)) {
    identifiers.push(name);
  } else if (
    ts.isObjectBindingPattern(name) ||
    ts.isArrayBindingPattern(name)
  ) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        bindingIdentifiers(element.name, identifiers);
      }
    }
  }
  return identifiers;
}

function directScopeBindings(scope) {
  const bindings = new Map();
  const statements =
    ts.isSourceFile(scope) || ts.isBlock(scope) ? scope.statements : [];
  for (const statement of statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) bindings.set(clause.name.text, clause.name);
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        bindings.set(named.name.text, named.name);
      } else if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          bindings.set(element.name.text, element.name);
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const identifier of bindingIdentifiers(declaration.name)) {
          bindings.set(identifier.text, identifier);
        }
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      bindings.set(statement.name.text, statement.name);
    }
  }
  return bindings;
}

function nearestBinding(identifier) {
  let current = identifier.parent;
  while (current) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      const binding = directScopeBindings(current).get(identifier.text);
      if (binding) return binding;
    }
    if (ts.isFunctionLike(current)) {
      for (const parameter of current.parameters) {
        const binding = bindingIdentifiers(parameter.name).find(
          (candidate) => candidate.text === identifier.text,
        );
        if (binding) return binding;
      }
      if (
        (ts.isFunctionExpression(current) ||
          ts.isFunctionDeclaration(current)) &&
        current.name?.text === identifier.text
      ) {
        return current.name;
      }
    }
    if (ts.isCatchClause(current) && current.variableDeclaration) {
      const binding = bindingIdentifiers(current.variableDeclaration.name).find(
        (candidate) => candidate.text === identifier.text,
      );
      if (binding) return binding;
    }
    current = current.parent;
  }
  return undefined;
}

function topLevelUnits(sourceFile) {
  const units = new Map();
  const add = (name, unit) => {
    if (units.has(name)) {
      throw new Error(
        `[view-bundle-guard] duplicate top-level declaration for ${name}`,
      );
    }
    units.set(name, unit);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      add(statement.name.text, {
        callable: true,
        declaration: statement.name,
        exported: hasExportModifier(statement),
        node: statement,
      });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        const initializer = unwrapExpression(declaration.initializer);
        add(declaration.name.text, {
          callable:
            ts.isArrowFunction(initializer) ||
            ts.isFunctionExpression(initializer),
          declaration: declaration.name,
          exported: hasExportModifier(statement),
          node: initializer,
        });
      }
    }
  }
  return units;
}

function assertLoaderMapIsRuntimeReachable(declaration, loaderFile, units) {
  const unitByDeclaration = new Map(
    [...units.values()].map((unit) => [unit.declaration, unit]),
  );
  const graph = new Map();
  for (const [name, unit] of units) {
    const dependencies = new Set();
    let consumesMap = false;
    const visit = (node) => {
      if (
        node !== unit.node &&
        (ts.isFunctionLike(node) || ts.isClassLike(node))
      ) {
        return;
      }
      if (
        ts.isIdentifier(node) &&
        node !== declaration.name &&
        nearestBinding(node) === declaration.name
      ) {
        consumesMap = true;
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        if (ts.isIdentifier(callee)) {
          const target = unitByDeclaration.get(nearestBinding(callee));
          if (target && target !== unit) dependencies.add(target);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(unit.node);
    graph.set(name, { consumesMap, dependencies });
  }
  const hostImport = units.get("hostImport");
  if (!hostImport?.exported || !hostImport.callable) {
    throw new Error(
      `[view-bundle-guard] ${loaderFile} must directly export a callable hostImport`,
    );
  }
  const pending = [hostImport];
  const visited = new Set();
  while (pending.length > 0) {
    const unit = pending.pop();
    if (visited.has(unit)) continue;
    visited.add(unit);
    const record = graph.get(unit.declaration.text);
    if (record?.consumesMap) return;
    pending.push(...(record?.dependencies ?? []));
  }
  throw new Error(
    `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS in ${loaderFile} is not consumed by the exported hostImport call path`,
  );
}

function returnedExpression(callable) {
  if (ts.isArrowFunction(callable) && !ts.isBlock(callable.body)) {
    return callable.body;
  }
  const body = callable.body;
  if (!body || !ts.isBlock(body) || body.statements.length !== 1) {
    return undefined;
  }
  const statement = body.statements[0];
  return ts.isReturnStatement(statement) ? statement.expression : undefined;
}

function unwrapReturnedExpression(expression) {
  let current = expression && unwrapExpression(expression);
  while (current && ts.isAwaitExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return current;
}

function assertHostImportWrapper(identifier, file) {
  const declaration = nearestBinding(identifier);
  const fn =
    declaration &&
    ts.isIdentifier(declaration) &&
    ts.isFunctionDeclaration(declaration.parent)
      ? declaration.parent
      : undefined;
  const parameter = fn?.parameters[0];
  const statement = fn?.body?.statements[0];
  const returned =
    fn?.parameters.length === 1 &&
    parameter &&
    ts.isIdentifier(parameter.name) &&
    fn.body?.statements.length === 1 &&
    statement &&
    ts.isReturnStatement(statement)
      ? unwrapReturnedExpression(statement.expression)
      : undefined;
  if (
    !returned ||
    !ts.isCallExpression(returned) ||
    returned.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    returned.arguments.length !== 1 ||
    !ts.isIdentifier(returned.arguments[0]) ||
    returned.arguments[0].text !== parameter.name.text
  ) {
    throw new Error(
      `[view-bundle-guard] ${file} importHostExternal must directly return a dynamic import of its sole parameter`,
    );
  }
}

function directImporterCallSpecifier(expression, file) {
  const value = unwrapReturnedExpression(expression);
  if (!value || !ts.isCallExpression(value)) return undefined;
  const isDynamicImport = value.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isHostImport =
    ts.isIdentifier(value.expression) &&
    value.expression.text === "importHostExternal";
  if (!isDynamicImport && !isHostImport) return undefined;
  if (isHostImport) assertHostImportWrapper(value.expression, file);
  if (
    value.arguments.length !== 1 ||
    !ts.isStringLiteralLike(value.arguments[0])
  ) {
    throw new Error(
      `[view-bundle-guard] ${file} importer must consume one literal specifier`,
    );
  }
  return value.arguments[0].text;
}

function hasTerminalValueReturn(unit) {
  const root = unit.node;
  if (ts.isArrowFunction(root) && !ts.isBlock(root.body)) return true;
  const finalStatement = root.body?.statements?.at(-1);
  return (
    finalStatement !== undefined &&
    ts.isReturnStatement(finalStatement) &&
    finalStatement.expression !== undefined
  );
}

function hasDirectThrow(callable) {
  let found = false;
  const visit = (node) => {
    if (
      node !== callable &&
      (ts.isFunctionLike(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node))
    ) {
      return;
    }
    if (ts.isThrowStatement(node)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(callable);
  return found;
}

function validateLoaderSpecifierBinding(key, imported, file) {
  if (imported.startsWith(".")) {
    const expected = LOADER_RELATIVE_IMPORT_BINDINGS.get(key);
    if (expected === imported) return;
    throw new Error(
      `[view-bundle-guard] ${file} loader importer for ${key} consumes mismatched relative specifier ${imported}; expected ${expected ?? "<none>"}`,
    );
  }
  if (imported !== key) {
    throw new Error(
      `[view-bundle-guard] ${file} loader importer for ${key} consumes mismatched specifier ${imported}`,
    );
  }
}

function namespaceImportSpecifier(identifier) {
  const binding = nearestBinding(identifier);
  const namespaceImport = binding?.parent;
  const declaration = namespaceImport?.parent?.parent;
  if (
    !namespaceImport ||
    !ts.isNamespaceImport(namespaceImport) ||
    !declaration ||
    !ts.isImportDeclaration(declaration) ||
    !ts.isStringLiteralLike(declaration.moduleSpecifier)
  ) {
    return undefined;
  }
  return declaration.moduleSpecifier.text;
}

function validateJsxDevRuntimeImporter(callable, key, file) {
  const imports = [];
  let hasReturn = false;
  const visit = (node) => {
    if (
      node !== callable &&
      (ts.isFunctionLike(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node))
    ) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) hasReturn = true;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch"
    ) {
      throw new Error(
        `[view-bundle-guard] ${file} loader importer may not catch and fabricate a module`,
      );
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      if (
        node.arguments.length !== 1 ||
        !ts.isStringLiteralLike(node.arguments[0])
      ) {
        throw new Error(
          `[view-bundle-guard] ${file} loader importer must consume literal specifiers`,
        );
      }
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(callable);
  if (
    !hasReturn ||
    imports.length !== 2 ||
    imports[0] !== key ||
    imports[1] !== "react/jsx-runtime"
  ) {
    throw new Error(
      `[view-bundle-guard] ${file} ${key} importer must preserve its explicit development-to-production runtime fallback`,
    );
  }
}

function validateLoaderImporter(property, key, units, file) {
  if (!ts.isPropertyAssignment(property)) {
    throw new Error(
      `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS in ${file} must assign each specifier to a callable importer`,
    );
  }
  const value = unwrapExpression(property.initializer);
  if (ts.isIdentifier(value)) {
    const unitByDeclaration = new Map(
      [...units.values()].map((unit) => [unit.declaration, unit]),
    );
    const unit = unitByDeclaration.get(nearestBinding(value));
    const expectedImporter = LOADER_NAMED_IMPORTER_BINDINGS.get(key);
    if (
      value.text !== expectedImporter ||
      !unit?.callable ||
      // Named compatibility adapters may receive an already-captured scope,
      // but must remain callable without arguments. Inline and registered
      // importers retain their stricter zero-parameter contract below.
      unit.node.parameters.some(
        (parameter) =>
          parameter.dotDotDotToken ||
          !ts.isIdentifier(parameter.name) ||
          (!parameter.initializer && !parameter.questionToken),
      ) ||
      !hasTerminalValueReturn(unit) ||
      hasDirectThrow(unit.node)
    ) {
      throw new Error(
        `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS ${key} value in ${file} does not resolve to its expected callable importer ${expectedImporter ?? "<none>"}`,
      );
    }
    return;
  }
  if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) {
    throw new Error(
      `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS ${key} value in ${file} must be callable`,
    );
  }
  if (value.parameters.length !== 0) {
    throw new Error(
      `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS ${key} importer in ${file} may not require arguments`,
    );
  }
  const result = returnedExpression(value);
  if (result) {
    const imported = directImporterCallSpecifier(result, file);
    if (imported !== undefined) {
      validateLoaderSpecifierBinding(key, imported, file);
      return;
    }
    const returned = unwrapReturnedExpression(result);
    if (returned && ts.isIdentifier(returned)) {
      const imported = namespaceImportSpecifier(returned);
      const expected = LOADER_NAMESPACE_IMPORT_BINDINGS.get(key);
      if (imported !== undefined && imported === expected) return;
      if (imported !== undefined) {
        throw new Error(
          `[view-bundle-guard] ${file} loader importer for ${key} consumes mismatched namespace ${imported}; expected ${expected ?? "<none>"}`,
        );
      }
    }
    throw new Error(
      `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS ${key} callable in ${file} does not directly return a module importer`,
    );
  }
  if (key === "react/jsx-dev-runtime") {
    validateJsxDevRuntimeImporter(value, key, file);
    return;
  }
  throw new Error(
    `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS ${key} callable in ${file} must directly return its module`,
  );
}

function importedLocalName(sourceFile, imported, moduleSpecifier, file) {
  const names = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleSpecifier ||
      statement.importClause?.isTypeOnly ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      if (
        !element.isTypeOnly &&
        (element.propertyName?.text ?? element.name.text) === imported
      ) {
        names.push(element.name.text);
      }
    }
  }
  if (names.length !== 1) {
    throw new Error(
      `[view-bundle-guard] ${file} must import ${imported} exactly once from ${moduleSpecifier}`,
    );
  }
  return names[0];
}

function exportedSynchronousInitializers(sourceFile, file) {
  const initializers = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      statement.body &&
      hasExportModifier(statement)
    ) {
      if (
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        ) ||
        statement.asteriskToken
      ) {
        throw new Error(
          `[view-bundle-guard] ${file} host-external initializer must be synchronous`,
        );
      }
      initializers.push(statement);
    }
  }
  return initializers;
}

function directRegistrationCalls(initializer, localRegistrationName, file) {
  let shadowed = false;
  const findShadow = (node) => {
    if (
      ((ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
        ts.isIdentifier(node.name) &&
        node.name.text === localRegistrationName) ||
      ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node !== initializer &&
        node.name?.text === localRegistrationName)
    ) {
      shadowed = true;
    }
    ts.forEachChild(node, findShadow);
  };
  findShadow(initializer);
  if (shadowed) {
    throw new Error(
      `[view-bundle-guard] ${file} shadows the registration API inside its initializer`,
    );
  }
  const calls = [];
  for (const statement of initializer.body.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(unwrapExpression(statement.expression)) &&
      ts.isIdentifier(unwrapExpression(statement.expression).expression) &&
      unwrapExpression(statement.expression).expression.text ===
        localRegistrationName
    ) {
      calls.push(unwrapExpression(statement.expression));
    }
  }
  let totalCalls = 0;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === localRegistrationName
    ) {
      totalCalls += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(initializer.body);
  if (calls.length !== totalCalls) {
    throw new Error(
      `[view-bundle-guard] ${file} registrations must be direct statements in the exported synchronous initializer`,
    );
  }
  return calls;
}

function callableImporterSpecifier(expression, file) {
  const callable = unwrapExpression(expression);
  if (!ts.isArrowFunction(callable) && !ts.isFunctionExpression(callable)) {
    throw new Error(
      `[view-bundle-guard] ${file} host-external importer must be an inline callable`,
    );
  }
  if (callable.parameters.length !== 0) {
    throw new Error(
      `[view-bundle-guard] ${file} host-external importer may not require arguments`,
    );
  }
  const result = returnedExpression(callable);
  const specifier =
    result === undefined
      ? undefined
      : directImporterCallSpecifier(result, file);
  if (specifier === undefined) {
    throw new Error(
      `[view-bundle-guard] ${file} host-external importer must directly return or await exactly one literal import without a fallback`,
    );
  }
  return specifier;
}

function registrationModuleSpecifier(registrationFile, entryFile) {
  const relative = path.posix.relative(
    path.posix.dirname(entryFile),
    registrationFile.replace(/\.[^.]+$/, ""),
  );
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function assertInitializerRunsAtEntry(
  initializerName,
  registrationFile,
  entryFile,
  entrySource,
) {
  if (typeof entrySource !== "string") {
    throw new Error(
      `[view-bundle-guard] ${registrationFile} requires an entry source proving its initializer runs`,
    );
  }
  const sourceFile = parseSource(entrySource, entryFile, ts.ScriptKind.TSX);
  const moduleSpecifier = registrationModuleSpecifier(
    registrationFile,
    entryFile,
  );
  const localName = importedLocalName(
    sourceFile,
    initializerName,
    moduleSpecifier,
    entryFile,
  );
  const calls = sourceFile.statements.filter(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(unwrapExpression(statement.expression)) &&
      ts.isIdentifier(unwrapExpression(statement.expression).expression) &&
      unwrapExpression(statement.expression).expression.text === localName &&
      unwrapExpression(statement.expression).arguments.length === 0,
  );
  if (calls.length !== 1) {
    throw new Error(
      `[view-bundle-guard] ${entryFile} must call ${initializerName} exactly once at module scope`,
    );
  }
}

/**
 * Extract the exact runtime host-external contract from parsed source.
 *
 * Comments and string examples cannot become allowlist entries, and every
 * extension source must import and call the real registration API with a
 * literal specifier.
 */
export function hostExternalSpecifiersFromSources(
  loaderSource,
  registrationSources,
) {
  const loaderFile = "<DynamicViewLoader.tsx>";
  const loader = parseSource(loaderSource, loaderFile, ts.ScriptKind.TSX);
  const units = topLevelUnits(loader);
  const declarations = [];
  const findDeclarations = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "HOST_EXTERNAL_IMPORTERS"
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, findDeclarations);
  };
  findDeclarations(loader);
  if (declarations.length !== 1) {
    throw new Error(
      `[view-bundle-guard] expected exactly one HOST_EXTERNAL_IMPORTERS declaration in ${loaderFile}, found ${declarations.length}`,
    );
  }
  const declarationStatement = declarations[0].parent?.parent;
  if (
    !declarationStatement ||
    !ts.isVariableStatement(declarationStatement) ||
    declarationStatement.parent !== loader
  ) {
    throw new Error(
      `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS in ${loaderFile} must be declared at module scope`,
    );
  }
  const initializer = declarations[0].initializer;
  const objectLiteral = initializer && unwrapExpression(initializer);
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) {
    throw new Error(
      `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS in ${loaderFile} must be an object literal`,
    );
  }

  const specifiers = new Set();
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      throw new Error(
        `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS in ${loaderFile} may not use spread properties`,
      );
    }
    const specifier = staticPropertyName(property, loaderFile);
    if (specifiers.has(specifier)) {
      throw new Error(
        `[view-bundle-guard] HOST_EXTERNAL_IMPORTERS contains duplicate specifier ${specifier}`,
      );
    }
    validateLoaderImporter(property, specifier, units, loaderFile);
    specifiers.add(specifier);
  }
  if (specifiers.size === 0) {
    throw new Error(
      "[view-bundle-guard] extracted zero host-external specifiers",
    );
  }
  assertLoaderMapIsRuntimeReachable(declarations[0], loaderFile, units);

  for (const { entryFile, entrySource, file, source } of registrationSources) {
    const sourceFile = parseSource(source, file, ts.ScriptKind.TS);
    const localRegistrationName = importedLocalName(
      sourceFile,
      "registerHostExternalImporter",
      "@elizaos/ui/app-shell-registry",
      file,
    );
    const initializers = exportedSynchronousInitializers(sourceFile, file);
    let initializer;
    let calls = [];
    for (const candidate of initializers) {
      const candidateCalls = directRegistrationCalls(
        candidate,
        localRegistrationName,
        file,
      );
      if (candidateCalls.length > 0) {
        if (initializer) {
          throw new Error(
            `[view-bundle-guard] ${file} must expose one host-external initializer`,
          );
        }
        initializer = candidate;
        calls = candidateCalls;
      }
    }
    if (!initializer?.name || calls.length === 0) {
      throw new Error(
        `[view-bundle-guard] ${file} contains no registrations in an exported synchronous initializer`,
      );
    }
    assertInitializerRunsAtEntry(
      initializer.name.text,
      file,
      entryFile,
      entrySource,
    );
    for (const call of calls) {
      if (call.arguments.length !== 2) {
        throw new Error(
          `[view-bundle-guard] ${file} host-external registration must receive exactly a specifier and importer`,
        );
      }
      const registeredSpecifier = call.arguments[0];
      const importer = call.arguments[1];
      if (
        !registeredSpecifier ||
        !ts.isStringLiteralLike(registeredSpecifier)
      ) {
        throw new Error(
          `[view-bundle-guard] ${file} must register host externals with literal specifiers`,
        );
      }
      if (!importer) {
        throw new Error(
          `[view-bundle-guard] ${file} must register a callable importer`,
        );
      }
      const importedSpecifier = callableImporterSpecifier(importer, file);
      if (importedSpecifier !== registeredSpecifier.text) {
        throw new Error(
          `[view-bundle-guard] ${file} importer for ${registeredSpecifier.text} consumes mismatched specifier ${importedSpecifier}`,
        );
      }
      if (specifiers.has(registeredSpecifier.text)) {
        throw new Error(
          `[view-bundle-guard] ${file} duplicates host-external specifier ${registeredSpecifier.text}`,
        );
      }
      specifiers.add(registeredSpecifier.text);
    }
  }
  return specifiers;
}

/** Read the host runtime sources and return their exact external specifiers. */
export async function getHostExternalSpecifiers() {
  const loaderSource = await fs.readFile(LOADER_PATH, "utf8");
  const registrationSources = await Promise.all(
    HOST_EXTERNAL_REGISTRATION_PATHS.map(
      async ({ entryPath, registrationPath }) => ({
        entryFile: path.relative(repoRoot, entryPath).split(path.sep).join("/"),
        entrySource: await fs.readFile(entryPath, "utf8"),
        file: path
          .relative(repoRoot, registrationPath)
          .split(path.sep)
          .join("/"),
        source: await fs.readFile(registrationPath, "utf8"),
      }),
    ),
  );
  return hostExternalSpecifiersFromSources(loaderSource, registrationSources);
}

/** Pull every static or literal dynamic bare import from an emitted ESM bundle. */
export function bareImportSpecifiers(source, file = "<view-bundle>") {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics?.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    throw new Error(
      `[view-bundle-guard] ${file} is not parseable JavaScript: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
  }

  const out = new Set();
  const add = (specifier) => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    const spec = specifier.text;
    if (spec.startsWith(".") || spec.startsWith("/")) {
      throw new Error(
        `[view-bundle-guard] ${file} contains a relative or absolute-path import (${spec}); view bundles must be self-contained`,
      );
    }
    out.add(spec);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      if (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0])) {
        throw new Error(
          `[view-bundle-guard] ${file} contains a computed dynamic import that the host cannot validate or rewrite`,
        );
      }
      add(node.arguments[0]);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      throw new Error(
        `[view-bundle-guard] ${file} contains CommonJS require(), which is unavailable in a browser ESM bundle`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** Require an emitted bundle to contribute a non-empty runtime namespace. */
export function assertViewBundleExports(source, file = "<view-bundle>") {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics?.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    throw new Error(
      `[view-bundle-guard] ${file} is not parseable JavaScript: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
  }
  const hasRuntimeExport = sourceFile.statements.some((statement) => {
    if (ts.isExportAssignment(statement)) return true;
    if (
      (ts.isVariableStatement(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      hasExportModifier(statement)
    ) {
      return true;
    }
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) {
      return false;
    }
    if (!statement.exportClause) return true;
    if (ts.isNamespaceExport(statement.exportClause)) return true;
    return statement.exportClause.elements.some(
      (element) => !element.isTypeOnly,
    );
  });
  if (!hasRuntimeExport) {
    throw new Error(`[view-bundle-guard] ${file} exports no runtime bindings`);
  }
}

/**
 * Resolve every expected bundle through the same workspace inventory as the
 * producer. Tests may inject inventory options to exercise malformed trees.
 */
export function listExpectedViewBundles(options = {}) {
  const root = path.resolve(options.repoRoot ?? repoRoot);
  const inventory = discoverViewBundleInventory({
    ...options,
    repoRoot: root,
  });
  return inventory.targets.map((target) => ({
    name: target.name,
    bundle: target.bundleAbsolute,
    relativeBundle: target.bundle,
    relativeConfig: target.config,
  }));
}

async function listBuiltBundles(options = {}) {
  const expected = options.expected ?? listExpectedViewBundles(options);
  const bundles = [];
  const missingBundles = [];
  for (const entry of expected) {
    try {
      const metadata = await fs.lstat(entry.bundle);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(
          `[view-bundle-guard] expected bundle is not a regular file: ${entry.relativeBundle}`,
        );
      }
      if (metadata.size === 0) {
        throw new Error(
          `[view-bundle-guard] expected bundle is empty: ${entry.relativeBundle}`,
        );
      }
    } catch (error) {
      // error-policy:J3 ENOENT becomes an explicit missingBundles record the
      // guard reports as a failure — never a silently shorter bundle list;
      // every other stat failure propagates.
      if (error?.code === "ENOENT") {
        missingBundles.push(entry);
        continue;
      }
      throw error;
    }
    bundles.push(entry);
  }
  return { bundles, missingBundles, expectedBundleCount: expected.length };
}

/** Classify a directory entry without treating devices or sockets as absent. */
export function viewOutputEntryKind(entry, file) {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile() || entry.isSymbolicLink()) return "file";
  throw new Error(
    `[view-bundle-guard] unsupported filesystem entry in view output: ${file}`,
  );
}

async function listOutputFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const kind = viewOutputEntryKind(entry, absolute);
    if (kind === "directory") {
      files.push(...(await listOutputFiles(absolute)));
    } else {
      files.push(absolute);
    }
  }
  return files;
}

async function listUnexpectedOutputs(expected) {
  const chunks = [];
  const artifacts = [];
  for (const entry of expected) {
    const directory = path.dirname(entry.bundle);
    let files;
    try {
      files = await listOutputFiles(directory);
    } catch (error) {
      // error-policy:J3 an absent output directory legitimately has zero
      // unexpected outputs (the bundle itself is reported missing by
      // listBuiltBundles); every other readdir failure propagates.
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const file of files) {
      const metadata = await fs.lstat(file);
      const isSymlink = metadata.isSymbolicLink();
      if (!isSymlink && path.resolve(file) === path.resolve(entry.bundle)) {
        continue;
      }
      if (
        !isSymlink &&
        path.resolve(file) === path.resolve(`${entry.bundle}.map`)
      ) {
        continue;
      }
      const record = {
        name: entry.name,
        artifact: file,
        relativeArtifact: path
          .relative(path.dirname(path.dirname(directory)), file)
          .split(path.sep)
          .join("/"),
      };
      if (!isSymlink && /\.(?:js|mjs|cjs)$/i.test(file)) {
        chunks.push({
          ...record,
          chunk: record.artifact,
          relativeChunk: record.relativeArtifact,
        });
      } else {
        artifacts.push(record);
      }
    }
  }
  return { unexpectedChunks: chunks, unexpectedArtifacts: artifacts };
}

/**
 * Validate every expected view bundle. Returns missing bundle records plus
 * import violations `{ plugin, specifier }`; both empty when every bundle is
 * present and loadable.
 */
export async function validateViewBundles(options = {}) {
  const allowed =
    options.allowedSpecifiers === undefined
      ? await getHostExternalSpecifiers()
      : new Set(options.allowedSpecifiers);
  const expected = listExpectedViewBundles(options);
  const { bundles, missingBundles, expectedBundleCount } =
    await listBuiltBundles({ ...options, expected });
  // TypeScript package builds legitimately emit declarations and importable
  // modules beside bundle.js. Only the dedicated clean Vite producer can prove
  // that another file is a bundle artifact, so strict output-shape validation
  // is opt-in there rather than at the post-Turbo import-check boundary.
  const { unexpectedChunks, unexpectedArtifacts } = options.enforceFreshOutputs
    ? await listUnexpectedOutputs(expected)
    : { unexpectedChunks: [], unexpectedArtifacts: [] };
  const violations = [];
  for (const { name, bundle } of bundles) {
    const source = await fs.readFile(bundle, "utf8");
    assertViewBundleExports(source, bundle);
    for (const spec of bareImportSpecifiers(source, bundle)) {
      if (!allowed.has(spec))
        violations.push({ plugin: name, specifier: spec });
    }
  }
  return {
    violations,
    missingBundles,
    unexpectedChunks,
    unexpectedArtifacts,
    bundleCount: bundles.length,
    expectedBundleCount,
    allowedCount: allowed.size,
  };
}

// CLI entry: `bun packages/scripts/view-bundle-import-guard.mjs`
if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  const {
    violations,
    missingBundles,
    unexpectedChunks,
    unexpectedArtifacts,
    bundleCount,
    expectedBundleCount,
    allowedCount,
  } = await validateViewBundles();
  if (
    missingBundles.length === 0 &&
    violations.length === 0 &&
    unexpectedChunks.length === 0 &&
    unexpectedArtifacts.length === 0
  ) {
    console.log(
      `[view-bundle-guard] OK — ${bundleCount}/${expectedBundleCount} bundle(s) present and import only host-external specifiers (${allowedCount} allowed).`,
    );
    process.exit(0);
  }
  if (missingBundles.length > 0) {
    console.error(
      `[view-bundle-guard] ${missingBundles.length} expected view bundle(s) missing.\n` +
        "Each plugin with vite.config.views.ts must produce dist/views/bundle.js during\n" +
        "the Turbo build; otherwise the root build would ship a view manifest with no\n" +
        "browser-loadable bundle.\n",
    );
    for (const bundle of missingBundles) {
      console.error(
        `  ✗ ${bundle.name}: missing ${bundle.relativeBundle} (declared by ${bundle.relativeConfig})`,
      );
    }
  }
  if (violations.length > 0) {
    console.error(
      `[view-bundle-guard] ${violations.length} un-loadable import(s) found.\n` +
        "These specifiers are externalised by the view build but NOT rewritable by\n" +
        "DynamicViewLoader, so the view fails to load in the browser. Import them from\n" +
        "a specifier the loader's HOST_EXTERNAL_IMPORTERS map already provides (e.g. the\n" +
        "`@elizaos/ui/components` barrel) instead of a deep subpath, or contribute the\n" +
        "specifier through registerHostExternalImporter (see packages/app/src/host-externals.ts).\n",
    );
    for (const v of violations) {
      console.error(`  ✗ ${v.plugin}: ${v.specifier}`);
    }
  }
  if (unexpectedChunks.length > 0) {
    console.error(
      `[view-bundle-guard] ${unexpectedChunks.length} unexpected JavaScript chunk(s) found; each view must emit only bundle.js.\n`,
    );
    for (const chunk of unexpectedChunks) {
      console.error(`  ✗ ${chunk.name}: ${chunk.relativeChunk}`);
    }
  }
  if (unexpectedArtifacts.length > 0) {
    console.error(
      `[view-bundle-guard] ${unexpectedArtifacts.length} unexpected sidecar artifact(s) found; only bundle.js and bundle.js.map may be emitted.\n`,
    );
    for (const artifact of unexpectedArtifacts) {
      console.error(`  ✗ ${artifact.name}: ${artifact.relativeArtifact}`);
    }
  }
  process.exit(1);
}
