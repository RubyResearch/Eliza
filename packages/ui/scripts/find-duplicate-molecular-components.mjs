#!/usr/bin/env node
/**
 * Groups exported React compositions by product role and canonical atomic
 * dependencies. Detection creates a review queue for repeated molecular UI;
 * the committed report requires a final disposition for every cluster.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import {
  buildInventory,
  compareCodePoints,
  listMaintainedSourceFiles,
} from "./find-duplicate-components.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const reportJson = path.join(
  scriptDir,
  "duplicate-molecular-components-report.json",
);
const reportMarkdown = path.join(
  scriptDir,
  "duplicate-molecular-components-report.md",
);
const decisionsPath = path.join(
  scriptDir,
  "molecular-inventory-decisions.json",
);
const contractsPath = path.join(scriptDir, "molecule-contracts.json");
const repoRoot = path.resolve(scriptDir, "../../..");
const sourceFileCache = new Map();
const compositionCache = new Map();
const moduleExportCache = new Map();

const FINAL_DISPOSITIONS = new Set([
  "distinct-domain-compositions",
  "shared-lifecycle-owner",
]);
const WORKFLOW_DISPOSITIONS = new Set(["unresolved", "canonicalize"]);
const ALLOWED_DISPOSITIONS = new Set([
  ...FINAL_DISPOSITIONS,
  ...WORKFLOW_DISPOSITIONS,
]);

const ARCHETYPES = [
  ["empty-state", /(EmptyState|Empty|Unavailable|NoResults)$/],
  ["dialog", /(Dialog|Modal|Sheet|Drawer)$/],
  ["form", /(Form|Editor|Composer)$/],
  ["picker", /(Picker|Selector|Chooser|Switcher)$/],
  ["table", /(Table|Grid)$/],
  ["list", /(List|Feed)$/],
  ["card", /(Card|Tile|Widget)$/],
  ["row", /(Row|Item|Cell)$/],
  ["panel", /(Panel|Section|Pane)$/],
  ["header", /(Header|Toolbar|Bar)$/],
  ["navigation", /(Sidebar|Navigation|Nav|Tabs)$/],
];

function archetypeFor(name) {
  return ARCHETYPES.find(([, pattern]) => pattern.test(name))?.[0] ?? null;
}

function componentId(component) {
  return `${component.file}:${component.name}`;
}

export function molecularClusterBinding(cluster) {
  const memberComponentIds = cluster.entries
    .map(componentId)
    .sort(compareCodePoints);
  const semanticInput = {
    archetype: cluster.archetype,
    atomicDependencies: [...cluster.atomicDependencies].sort(compareCodePoints),
    members: cluster.entries
      .map((entry) => ({
        atomicDependencies: [...entry.atomicDependencies].sort(
          compareCodePoints,
        ),
        id: componentId(entry),
        renderedTags: [...entry.renderedTags].sort(compareCodePoints),
      }))
      .sort((a, b) => compareCodePoints(a.id, b.id)),
  };
  const semanticFingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(semanticInput))
    .digest("hex")}`;
  return { memberComponentIds, semanticFingerprint };
}

export function validateMolecularDecisions(
  clusters,
  decisions,
  canonicalContractIds = new Set(),
) {
  const clusterSignatures = new Set(
    clusters.map((cluster) => cluster.signature),
  );
  const missingDecisions = [];
  const invalidDecisions = [];
  const nonFinalDecisions = [];

  for (const cluster of clusters) {
    const decision = decisions[cluster.signature];
    if (
      !decision ||
      typeof decision.disposition !== "string" ||
      typeof decision.rationale !== "string" ||
      decision.rationale.trim().length === 0
    ) {
      missingDecisions.push(cluster.signature);
      continue;
    }

    const expectedBinding = molecularClusterBinding(cluster);
    if (
      JSON.stringify(decision.memberComponentIds) !==
      JSON.stringify(expectedBinding.memberComponentIds)
    ) {
      invalidDecisions.push(
        `${cluster.signature} member IDs changed (recorded: ${Array.isArray(decision.memberComponentIds) ? decision.memberComponentIds.join(", ") : "invalid"}; current: ${expectedBinding.memberComponentIds.join(", ")})`,
      );
    }
    if (decision.semanticFingerprint !== expectedBinding.semanticFingerprint) {
      invalidDecisions.push(
        `${cluster.signature} semantic fingerprint changed (recorded: ${decision.semanticFingerprint ?? "missing"}; current: ${expectedBinding.semanticFingerprint})`,
      );
    }
    if (!ALLOWED_DISPOSITIONS.has(decision.disposition)) {
      invalidDecisions.push(
        `${cluster.signature} has unknown disposition ${decision.disposition}`,
      );
    }
    if (decision.disposition === "canonicalize") {
      if (
        typeof decision.canonicalContractId !== "string" ||
        decision.canonicalContractId.trim() === ""
      ) {
        invalidDecisions.push(
          `${cluster.signature} canonicalize workflow requires canonicalContractId`,
        );
      } else if (!canonicalContractIds.has(decision.canonicalContractId)) {
        invalidDecisions.push(
          `${cluster.signature} references unknown canonical contract ${decision.canonicalContractId}`,
        );
      }
    } else if ("canonicalContractId" in decision) {
      invalidDecisions.push(
        `${cluster.signature} may name canonicalContractId only while canonicalizing`,
      );
    }
    if (WORKFLOW_DISPOSITIONS.has(decision.disposition)) {
      nonFinalDecisions.push(`${cluster.signature} (${decision.disposition})`);
    }
  }

  const staleDecisions = Object.keys(decisions).filter(
    (signature) => !clusterSignatures.has(signature),
  );

  if (
    missingDecisions.length > 0 ||
    invalidDecisions.length > 0 ||
    nonFinalDecisions.length > 0 ||
    staleDecisions.length > 0
  ) {
    throw new Error(
      `Molecular decisions must match the current clusters and be final. Missing: ${missingDecisions.join(", ") || "none"}; invalid: ${invalidDecisions.join("; ") || "none"}; non-final: ${nonFinalDecisions.join(", ") || "none"}; stale: ${staleDecisions.join(", ") || "none"}. Allowed final dispositions: ${[...FINAL_DISPOSITIONS].join(", ")}. Workflow dispositions unresolved and canonicalize always fail this completion gate.`,
    );
  }
}

function transitiveAtomicDependencies(owner, components, atoms) {
  const dependencies = new Set(owner.atomicDependencies);
  const visited = new Set();
  const visit = (component) => {
    const key = `${component.file}:${component.name}`;
    if (visited.has(key)) return;
    visited.add(key);
    for (const dependency of component.atomicDependencies) {
      dependencies.add(dependency);
    }
    for (const tag of component.renderedTags) {
      for (const child of components.filter((entry) => entry.name === tag)) {
        visit(child);
      }
    }
  };
  visit(owner);

  if (atoms) {
    const source = fs.readFileSync(path.join(repoRoot, owner.file), "utf8");
    for (const [kind, inventory] of Object.entries(atoms)) {
      const symbols = inventory.canonical
        .map((entry) => entry.name)
        .filter((name) => typeof name === "string");
      if (
        symbols.some(
          (symbol) =>
            source.includes(`<${symbol}`) ||
            source.includes(`createElement(${symbol}`),
        )
      ) {
        dependencies.add(kind);
      }
    }
  }
  return dependencies;
}

export function validateMoleculeContracts(
  components,
  contracts,
  references,
  atoms,
) {
  const errors = [];
  const ids = new Set();
  const owners = new Set();

  for (const contract of contracts) {
    const ownerKey = `${contract.owner}:${contract.symbol}`;
    if (ids.has(contract.id)) errors.push(`duplicate id ${contract.id}`);
    if (owners.has(ownerKey)) errors.push(`duplicate owner ${ownerKey}`);
    ids.add(contract.id);
    owners.add(ownerKey);

    const owner = components.find(
      (component) =>
        component.file === contract.owner && component.name === contract.symbol,
    );
    if (!owner) {
      errors.push(`missing owner ${ownerKey}`);
      continue;
    }

    const liveDependencies = transitiveAtomicDependencies(
      owner,
      components,
      atoms,
    );
    const missingDependencies = contract.requiredAtomicDependencies.filter(
      (dependency) => !liveDependencies.has(dependency),
    );
    if (missingDependencies.length > 0) {
      errors.push(
        `${ownerKey} is missing atomic dependencies ${missingDependencies.join(", ")}`,
      );
    }

    const missingTags = (contract.requiredRenderedTags ?? []).filter(
      (tag) => !owner.renderedTags.includes(tag),
    );
    if (missingTags.length > 0) {
      errors.push(
        `${ownerKey} is missing rendered tags ${missingTags.join(", ")}`,
      );
    }

    const referenceCount = references[ownerKey] ?? 0;
    if (referenceCount < contract.minimumMaintainedReferences) {
      errors.push(
        `${ownerKey} has ${referenceCount} maintained references; expected at least ${contract.minimumMaintainedReferences}`,
      );
    }

    for (const consumerFile of contract.requiredConsumerFiles ?? []) {
      const absoluteConsumer = path.join(repoRoot, consumerFile);
      if (
        !fs.existsSync(absoluteConsumer) ||
        !fileComposesContract(absoluteConsumer, contract)
      ) {
        errors.push(
          `${consumerFile} no longer consumes canonical ${contract.symbol}`,
        );
      }
    }

    if (typeof contract.renderedStory !== "string") {
      errors.push(`${ownerKey} is missing rendered story evidence`);
    } else {
      const absoluteStory = path.join(repoRoot, contract.renderedStory);
      if (
        !fs.existsSync(absoluteStory) ||
        !fileRendersContract(absoluteStory, contract)
      ) {
        errors.push(
          `${contract.renderedStory} no longer renders canonical ${contract.symbol}`,
        );
      }
    }

    if (typeof contract.behavioralTest !== "string") {
      errors.push(`${ownerKey} is missing behavioral test evidence`);
    } else {
      const absoluteTest = path.join(repoRoot, contract.behavioralTest);
      if (!fs.existsSync(absoluteTest)) {
        errors.push(`${contract.behavioralTest} behavioral test is missing`);
      } else {
        const source = fs.readFileSync(absoluteTest, "utf8");
        if (
          !/\b(?:it|test)\s*\(/.test(source) ||
          !fileComposesContract(absoluteTest, contract)
        ) {
          errors.push(
            `${contract.behavioralTest} does not render canonical ${contract.symbol} in a behavioral test`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Canonical molecule contracts failed: ${errors.join("; ")}`,
    );
  }
}

function maintainedReferenceCounts(contracts) {
  const references = Object.fromEntries(
    contracts.map((contract) => [`${contract.owner}:${contract.symbol}`, 0]),
  );
  const symbols = new Map(
    contracts.map((contract) => [contract.symbol, contract]),
  );

  for (const absoluteFile of listMaintainedSourceFiles()) {
    const file = path
      .relative(repoRoot, absoluteFile)
      .replaceAll(path.sep, "/");
    for (const [symbol, contract] of symbols) {
      if (file === contract.owner) continue;
      if (fileComposesContract(absoluteFile, contract)) {
        references[`${contract.owner}:${symbol}`] += 1;
      }
    }
  }
  return references;
}

function contractBindings(absoluteFile, contract, sourceFile) {
  const bindings = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const modulePath = resolveSourceModule(
      absoluteFile,
      statement.moduleSpecifier.text,
    );
    if (!modulePath) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (
        moduleExportsContract(modulePath, importedName, contract, new Set())
      ) {
        bindings.add(element.name.text);
      }
    }
  }
  return bindings;
}

export function fileComposesContract(absoluteFile, contract) {
  const cacheKey = `${absoluteFile}:${contract.owner}:${contract.symbol}`;
  if (compositionCache.has(cacheKey)) return compositionCache.get(cacheKey);
  const source = fs.readFileSync(absoluteFile, "utf8");
  const sourceFile = parsedSourceFile(absoluteFile, source);
  const bindings = contractBindings(absoluteFile, contract, sourceFile);
  let composed = false;
  const visit = (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      bindings.has(node.tagName.text)
    ) {
      composed = true;
      return;
    }
    if (!composed) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  compositionCache.set(cacheKey, composed);
  return composed;
}

export function fileRendersContract(absoluteFile, contract) {
  const source = fs.readFileSync(absoluteFile, "utf8");
  const sourceFile = parsedSourceFile(absoluteFile, source);
  const bindings = contractBindings(absoluteFile, contract, sourceFile);
  let rendered = false;
  const visit = (node) => {
    if (
      ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName) &&
        bindings.has(node.tagName.text)) ||
      (ts.isPropertyAssignment(node) &&
        node.name.getText(sourceFile) === "component" &&
        ts.isIdentifier(node.initializer) &&
        bindings.has(node.initializer.text))
    ) {
      rendered = true;
      return;
    }
    if (!rendered) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return rendered;
}

function moduleExportsContract(modulePath, exportedName, contract, visited) {
  const visitKey = `${modulePath}:${exportedName}`;
  if (visited.has(visitKey)) return false;
  visited.add(visitKey);
  const cacheKey = `${visitKey}:${contract.owner}:${contract.symbol}`;
  if (moduleExportCache.has(cacheKey)) return moduleExportCache.get(cacheKey);
  const relativeModule = path
    .relative(repoRoot, modulePath)
    .replaceAll(path.sep, "/");
  if (relativeModule === contract.owner && exportedName === contract.symbol) {
    moduleExportCache.set(cacheKey, true);
    return true;
  }

  const source = fs.readFileSync(modulePath, "utf8");
  const sourceFile = parsedSourceFile(modulePath, source);
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier)
      continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const nextModule = resolveSourceModule(
      modulePath,
      statement.moduleSpecifier.text,
    );
    if (!nextModule) continue;
    if (!statement.exportClause) {
      if (moduleExportsContract(nextModule, exportedName, contract, visited)) {
        moduleExportCache.set(cacheKey, true);
        return true;
      }
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.name.text !== exportedName) continue;
      const importedName = element.propertyName?.text ?? element.name.text;
      if (moduleExportsContract(nextModule, importedName, contract, visited)) {
        moduleExportCache.set(cacheKey, true);
        return true;
      }
    }
  }
  moduleExportCache.set(cacheKey, false);
  return false;
}

function parsedSourceFile(absoluteFile, source) {
  if (sourceFileCache.has(absoluteFile))
    return sourceFileCache.get(absoluteFile);
  const sourceFile = ts.createSourceFile(
    absoluteFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    absoluteFile.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  sourceFileCache.set(absoluteFile, sourceFile);
  return sourceFile;
}

function resolveSourceModule(importingFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importingFile), specifier);
  for (const candidate of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, "index.tsx"),
    path.join(base, "index.ts"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

export function parseMolecularDecisionRegistry(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 2 ||
    !value.decisions ||
    typeof value.decisions !== "object" ||
    Array.isArray(value.decisions)
  ) {
    throw new Error(
      "Molecular decision registry requires schemaVersion 2 and decisions",
    );
  }

  for (const [signature, decision] of Object.entries(value.decisions)) {
    const context = `Molecular decision ${signature}`;
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      throw new Error(`${context} must be an object`);
    }
    const allowedFields = new Set([
      "canonicalContractId",
      "disposition",
      "memberComponentIds",
      "rationale",
      "semanticFingerprint",
    ]);
    const unknownField = Object.keys(decision).find(
      (field) => !allowedFields.has(field),
    );
    if (unknownField) {
      throw new Error(`${context} has unknown field ${unknownField}`);
    }
    if (
      typeof decision.disposition !== "string" ||
      !ALLOWED_DISPOSITIONS.has(decision.disposition)
    ) {
      throw new Error(`${context} has an unknown disposition`);
    }
    if (
      typeof decision.rationale !== "string" ||
      decision.rationale.trim() === ""
    ) {
      throw new Error(`${context} requires a non-empty rationale`);
    }
    if (
      !Array.isArray(decision.memberComponentIds) ||
      decision.memberComponentIds.length < 2 ||
      decision.memberComponentIds.some(
        (id) => typeof id !== "string" || id.trim() === "",
      ) ||
      new Set(decision.memberComponentIds).size !==
        decision.memberComponentIds.length
    ) {
      throw new Error(
        `${context} requires at least two unique memberComponentIds`,
      );
    }
    if (
      typeof decision.semanticFingerprint !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(decision.semanticFingerprint)
    ) {
      throw new Error(`${context} requires a sha256 semanticFingerprint`);
    }
  }
  return value;
}

export function detectMolecularClusters(atomicComponents) {
  const components = atomicComponents
    .map((component) => ({
      ...component,
      archetype: archetypeFor(component.name),
    }))
    .filter(
      (component) =>
        component.archetype && component.atomicDependencies.length >= 2,
    );
  const bySignature = new Map();
  for (const component of components) {
    const signature = `${component.archetype}:${component.atomicDependencies.join("+")}`;
    if (!bySignature.has(signature)) bySignature.set(signature, []);
    bySignature.get(signature).push(component);
  }

  const clusters = [...bySignature]
    .map(([signature, entries]) => ({
      archetype: entries[0].archetype,
      atomicDependencies: entries[0].atomicDependencies,
      entries: entries.sort(
        (a, b) =>
          compareCodePoints(a.file, b.file) ||
          a.line - b.line ||
          compareCodePoints(a.name, b.name),
      ),
      signature,
    }))
    .filter((cluster) => cluster.entries.length >= 2)
    .sort(
      (a, b) =>
        b.entries.length - a.entries.length ||
        compareCodePoints(a.signature, b.signature),
    );
  return { clusters, eligibleComponents: components.length };
}

export function buildMolecularInventory() {
  const atomicReport = buildInventory();
  const decisions = parseMolecularDecisionRegistry(
    JSON.parse(fs.readFileSync(decisionsPath, "utf8")),
  ).decisions;
  const contractRegistry = parseMoleculeContractRegistry(
    JSON.parse(fs.readFileSync(contractsPath, "utf8")),
  );
  const references = maintainedReferenceCounts(contractRegistry.contracts);
  validateMoleculeContracts(
    atomicReport.components,
    contractRegistry.contracts,
    references,
    atomicReport.atoms,
  );
  const { clusters: detectedClusters, eligibleComponents } =
    detectMolecularClusters(atomicReport.components);
  validateMolecularDecisions(
    detectedClusters,
    decisions,
    new Set(contractRegistry.contracts.map((contract) => contract.id)),
  );
  const clusters = detectedClusters.map((cluster) => ({
    ...cluster,
    ...decisions[cluster.signature],
  }));

  return {
    schemaVersion: 3,
    sourceAtomicSchemaVersion: atomicReport.schemaVersion,
    scannedFiles: atomicReport.scannedFiles,
    canonicalContracts: contractRegistry.contracts.map((contract) => ({
      ...contract,
      maintainedReferences: references[`${contract.owner}:${contract.symbol}`],
    })),
    eligibleComponents,
    clusters,
    summary: {
      clusterCount: clusters.length,
      clusteredComponents: clusters.reduce(
        (total, cluster) => total + cluster.entries.length,
        0,
      ),
      largestCluster: clusters[0]?.entries.length ?? 0,
    },
  };
}

function isSafePackagesPath(value) {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !path.isAbsolute(value) &&
    !value.split("/").includes("..") &&
    value.startsWith("packages/")
  );
}

export function parseMoleculeContractRegistry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Molecule contract registry must be an object");
  }
  if (value.schemaVersion !== 2 || !Array.isArray(value.contracts)) {
    throw new Error(
      "Molecule contract registry requires schemaVersion 2 and contracts",
    );
  }

  for (const [index, contract] of value.contracts.entries()) {
    const context = `Molecule contract at index ${index}`;
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
      throw new Error(`${context} must be an object`);
    }
    const allowedFields = new Set([
      "behavioralTest",
      "id",
      "minimumMaintainedReferences",
      "owner",
      "renderedStory",
      "requiredAtomicDependencies",
      "requiredConsumerFiles",
      "requiredRenderedTags",
      "responsibility",
      "symbol",
    ]);
    const unknownField = Object.keys(contract).find(
      (field) => !allowedFields.has(field),
    );
    if (unknownField)
      throw new Error(`${context} has unknown field ${unknownField}`);
    for (const field of [
      "behavioralTest",
      "id",
      "owner",
      "renderedStory",
      "symbol",
      "responsibility",
    ]) {
      if (
        typeof contract[field] !== "string" ||
        contract[field].trim() === ""
      ) {
        throw new Error(`${context} requires non-empty ${field}`);
      }
    }
    if (!isSafePackagesPath(contract.owner)) {
      throw new Error(`${context} owner must be a safe packages-relative path`);
    }
    for (const field of [
      "requiredAtomicDependencies",
      "requiredRenderedTags",
      "requiredConsumerFiles",
    ]) {
      if (
        !Array.isArray(contract[field]) ||
        contract[field].some(
          (entry) => typeof entry !== "string" || entry.trim() === "",
        )
      ) {
        throw new Error(`${context} requires a string array for ${field}`);
      }
    }
    if (
      contract.requiredConsumerFiles.length < 2 ||
      new Set(contract.requiredConsumerFiles).size !==
        contract.requiredConsumerFiles.length ||
      contract.requiredConsumerFiles.some(
        (consumer) =>
          !isSafePackagesPath(consumer) || consumer === contract.owner,
      )
    ) {
      throw new Error(
        `${context} requires at least two distinct maintained consumer files`,
      );
    }
    if (
      !Number.isInteger(contract.minimumMaintainedReferences) ||
      contract.minimumMaintainedReferences < 2
    ) {
      throw new Error(
        `${context} requires a maintained reference floor of at least 2`,
      );
    }
    if (
      !isSafePackagesPath(contract.renderedStory) ||
      !/\.stories\.[jt]sx?$/.test(contract.renderedStory)
    ) {
      throw new Error(
        `${context} renderedStory must name a packages-relative Storybook story`,
      );
    }
    if (
      !isSafePackagesPath(contract.behavioralTest) ||
      !/\.(?:test|spec)\.[jt]sx?$/.test(contract.behavioralTest)
    ) {
      throw new Error(
        `${context} behavioralTest must name a packages-relative test`,
      );
    }
  }
  return value;
}

export function renderMolecularMarkdown(report) {
  const lines = [
    "# Molecular component duplicate inventory",
    "",
    `Scanned ${report.scannedFiles} maintained React files. ${report.eligibleComponents} exported compositions have a recognized molecular role and at least two atomic dependencies.`,
    "",
    "Clusters share both a role and an atomic dependency signature. Detection creates a review queue; this committed report contains only final dispositions based on product behavior, state ownership, and responsive layout.",
    "",
    "## Canonical molecule contracts",
    "",
    "These owners are fail-closed contracts. The audit fails if an owner disappears, drops a required canonical atom, loses a named consumer, or loses its rendered story or behavioral test.",
    "",
    "| Contract | Canonical owner | Maintained references | Representative proof | Responsibility |",
    "| --- | --- | ---: | --- | --- |",
    ...report.canonicalContracts.map(
      (contract) =>
        `| ${contract.id} | \`${contract.symbol}\` in \`${contract.owner}\` | ${contract.maintainedReferences} | \`${contract.renderedStory}\`<br>\`${contract.behavioralTest}\` | ${contract.responsibility} |`,
    ),
    "",
    "## Duplicate review queue",
    "",
    "| Role | Atomic dependencies | Components | Decision |",
    "| --- | --- | ---: | --- |",
  ];

  for (const cluster of report.clusters) {
    lines.push(
      `| ${cluster.archetype} | ${cluster.atomicDependencies.join(", ")} | ${cluster.entries.length} | ${cluster.disposition} |`,
    );
  }

  lines.push("", "## Reviewed clusters", "");
  for (const cluster of report.clusters) {
    lines.push(
      `### ${cluster.archetype}: ${cluster.atomicDependencies.join(" + ")}`,
      "",
    );
    for (const entry of cluster.entries) {
      lines.push(`- \`${entry.name}\` in \`${entry.file}:${entry.line}\``);
    }
    lines.push(`- Fingerprint: \`${cluster.semanticFingerprint}\``);
    lines.push(`- Decision: **${cluster.disposition}**. ${cluster.rationale}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function serializeMolecularReport(report) {
  return {
    json: `${JSON.stringify(report, null, 2)}\n`,
    markdown: renderMolecularMarkdown(report),
  };
}

// The scan count is a statistic of the tree, not a disposition: it moves
// whenever any PR adds or removes a React file, and comparing it made
// `--check` fail for every such PR until someone regenerated the artifact,
// which two people then raced to land. Regeneration still records the real
// count; the check compares only the reviewable content around it.
const SCAN_COUNT_SENTENCE = /^Scanned \d+ maintained React files\./m;

function withoutScanCount(report) {
  if (typeof report !== "object" || report === null) return report;
  const { scannedFiles: _scannedFiles, ...content } = report;
  return content;
}

function withoutMarkdownScanCount(markdown) {
  return markdown.replace(
    SCAN_COUNT_SENTENCE,
    "Scanned N maintained React files.",
  );
}

export function assertMolecularArtifactsCurrent(report, artifacts) {
  const stale = [];
  try {
    if (
      !isDeepStrictEqual(
        withoutScanCount(JSON.parse(artifacts.json)),
        withoutScanCount(report),
      )
    ) {
      stale.push("json");
    }
  } catch {
    stale.push("json");
  }
  if (
    withoutMarkdownScanCount(artifacts.markdown) !==
    withoutMarkdownScanCount(renderMolecularMarkdown(report))
  ) {
    stale.push("markdown");
  }
  if (stale.length > 0) {
    throw new Error(
      `Molecular inventory artifacts are stale: ${stale.join(", ")}. Run bun run --cwd packages/ui audit:molecular-inventory.`,
    );
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const report = buildMolecularInventory();
  const artifacts = serializeMolecularReport(report);
  if (process.argv.includes("--check")) {
    assertMolecularArtifactsCurrent(report, {
      json: fs.existsSync(reportJson)
        ? fs.readFileSync(reportJson, "utf8")
        : "",
      markdown: fs.existsSync(reportMarkdown)
        ? fs.readFileSync(reportMarkdown, "utf8")
        : "",
    });
    process.stdout.write(
      `Molecular inventory is current with ${report.clusters.length} final dispositions.\n`,
    );
  } else {
    fs.writeFileSync(reportJson, artifacts.json);
    fs.writeFileSync(reportMarkdown, artifacts.markdown);
    process.stdout.write(artifacts.markdown);
  }
}
