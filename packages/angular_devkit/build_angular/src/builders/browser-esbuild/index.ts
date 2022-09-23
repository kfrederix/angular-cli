/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { BuilderContext, BuilderOutput, createBuilder } from '@angular-devkit/architect';
import * as assert from 'assert';
import type { Message, OutputFile } from 'esbuild';
import { promises as fs } from 'fs';
import * as path from 'path';
import { NormalizedOptimizationOptions, deleteOutputDir } from '../../utils';
import { copyAssets } from '../../utils/copy-assets';
import { assertIsError } from '../../utils/error';
import { transformSupportedBrowsersToTargets } from '../../utils/esbuild-targets';
import { FileInfo } from '../../utils/index-file/augment-index-html';
import { IndexHtmlGenerator } from '../../utils/index-file/index-html-generator';
import { generateEntryPoints } from '../../utils/package-chunk-sort';
import { augmentAppWithServiceWorker } from '../../utils/service-worker';
import { getSupportedBrowsers } from '../../utils/supported-browsers';
import { getIndexInputFile, getIndexOutputFile } from '../../utils/webpack-browser-config';
import { normalizeGlobalStyles } from '../../webpack/utils/helpers';
import { createCompilerPlugin } from './compiler-plugin';
import { bundle, logMessages } from './esbuild';
import { logExperimentalWarnings } from './experimental-warnings';
import { normalizeOptions } from './options';
import { Schema as BrowserBuilderOptions, SourceMapClass } from './schema';
import { bundleStylesheetText } from './stylesheets';
import { createWatcher } from './watcher';

async function execute(
  options: BrowserBuilderOptions,
  normalizedOptions: Awaited<ReturnType<typeof normalizeOptions>>,
  context: BuilderContext,
): Promise<BuilderOutput> {
  const startTime = Date.now();

  const {
    projectRoot,
    workspaceRoot,
    entryPoints,
    entryPointNameLookup,
    optimizationOptions,
    outputPath,
    sourcemapOptions,
    tsconfig,
    assets,
    outputNames,
  } = normalizedOptions;

  const target = transformSupportedBrowsersToTargets(
    getSupportedBrowsers(projectRoot, context.logger),
  );

  const [codeResults, styleResults] = await Promise.all([
    // Execute esbuild to bundle the application code
    bundleCode(
      workspaceRoot,
      entryPoints,
      outputNames,
      options,
      optimizationOptions,
      sourcemapOptions,
      tsconfig,
      target,
    ),
    // Execute esbuild to bundle the global stylesheets
    bundleGlobalStylesheets(
      workspaceRoot,
      outputNames,
      options,
      optimizationOptions,
      sourcemapOptions,
      target,
    ),
  ]);

  // Log all warnings and errors generated during bundling
  await logMessages(context, {
    errors: [...codeResults.errors, ...styleResults.errors],
    warnings: [...codeResults.warnings, ...styleResults.warnings],
  });

  // Return if the bundling failed to generate output files or there are errors
  if (!codeResults.outputFiles || codeResults.errors.length) {
    return { success: false };
  }

  // Structure the code bundling output files
  const initialFiles: FileInfo[] = [];
  const outputFiles: OutputFile[] = [];
  for (const outputFile of codeResults.outputFiles) {
    // Entries in the metafile are relative to the `absWorkingDir` option which is set to the workspaceRoot
    const relativeFilePath = path.relative(workspaceRoot, outputFile.path);
    const entryPoint = codeResults.metafile?.outputs[relativeFilePath]?.entryPoint;

    outputFile.path = relativeFilePath;

    if (entryPoint) {
      // An entryPoint value indicates an initial file
      initialFiles.push({
        file: outputFile.path,
        name: entryPointNameLookup.get(entryPoint) ?? '',
        extension: path.extname(outputFile.path),
      });
    }
    outputFiles.push(outputFile);
  }

  // Add global stylesheets output files
  outputFiles.push(...styleResults.outputFiles);
  initialFiles.push(...styleResults.initialFiles);

  // Return if the global stylesheet bundling has errors
  if (styleResults.errors.length) {
    return { success: false };
  }

  // Generate index HTML file
  if (options.index) {
    const entrypoints = generateEntryPoints({
      scripts: options.scripts ?? [],
      styles: options.styles ?? [],
    });

    // Create an index HTML generator that reads from the in-memory output files
    const indexHtmlGenerator = new IndexHtmlGenerator({
      indexPath: path.join(context.workspaceRoot, getIndexInputFile(options.index)),
      entrypoints,
      sri: options.subresourceIntegrity,
      optimization: optimizationOptions,
      crossOrigin: options.crossOrigin,
    });

    /** Virtual output path to support reading in-memory files. */
    const virtualOutputPath = '/';
    indexHtmlGenerator.readAsset = async function (filePath: string): Promise<string> {
      // Remove leading directory separator
      const relativefilePath = path.relative(virtualOutputPath, filePath);
      const file = outputFiles.find((file) => file.path === relativefilePath);
      if (file) {
        return file.text;
      }

      throw new Error(`Output file does not exist: ${path}`);
    };

    const { content, warnings, errors } = await indexHtmlGenerator.process({
      baseHref: options.baseHref,
      lang: undefined,
      outputPath: virtualOutputPath,
      files: initialFiles,
    });

    for (const error of errors) {
      context.logger.error(error);
    }
    for (const warning of warnings) {
      context.logger.warn(warning);
    }

    outputFiles.push(createOutputFileFromText(getIndexOutputFile(options.index), content));
  }

  // Copy assets
  if (assets) {
    await copyAssets(assets, [outputPath], workspaceRoot);
  }

  // Write output files
  await Promise.all(
    outputFiles.map((file) => fs.writeFile(path.join(outputPath, file.path), file.contents)),
  );

  // Augment the application with service worker support
  // TODO: This should eventually operate on the in-memory files prior to writing the output files
  if (options.serviceWorker) {
    try {
      await augmentAppWithServiceWorker(
        projectRoot,
        workspaceRoot,
        outputPath,
        options.baseHref || '/',
        options.ngswConfigPath,
      );
    } catch (error) {
      context.logger.error(error instanceof Error ? error.message : `${error}`);

      return { success: false };
    }
  }

  context.logger.info(`Complete. [${(Date.now() - startTime) / 1000} seconds]`);

  return { success: true };
}

function createOutputFileFromText(path: string, text: string): OutputFile {
  return {
    path,
    text,
    get contents() {
      return Buffer.from(this.text, 'utf-8');
    },
  };
}

async function bundleCode(
  workspaceRoot: string,
  entryPoints: Record<string, string>,
  outputNames: { bundles: string; media: string },
  options: BrowserBuilderOptions,
  optimizationOptions: NormalizedOptimizationOptions,
  sourcemapOptions: SourceMapClass,
  tsconfig: string,
  target: string[],
) {
  let fileReplacements: Record<string, string> | undefined;
  if (options.fileReplacements) {
    for (const replacement of options.fileReplacements) {
      fileReplacements ??= {};
      fileReplacements[path.join(workspaceRoot, replacement.replace)] = path.join(
        workspaceRoot,
        replacement.with,
      );
    }
  }

  return bundle({
    absWorkingDir: workspaceRoot,
    bundle: true,
    format: 'esm',
    entryPoints,
    entryNames: outputNames.bundles,
    assetNames: outputNames.media,
    target,
    supported: {
      // Native async/await is not supported with Zone.js. Disabling support here will cause
      // esbuild to downlevel async/await and for await...of to a Zone.js supported form. However, esbuild
      // does not currently support downleveling async generators. Instead babel is used within the JS/TS
      // loader to perform the downlevel transformation.
      // NOTE: If esbuild adds support in the future, the babel support for async generators can be disabled.
      'async-await': false,
    },
    mainFields: ['es2020', 'browser', 'module', 'main'],
    conditions: ['es2020', 'es2015', 'module'],
    resolveExtensions: ['.ts', '.tsx', '.mjs', '.js'],
    logLevel: options.verbose ? 'debug' : 'silent',
    metafile: true,
    minify: optimizationOptions.scripts,
    pure: ['forwardRef'],
    outdir: workspaceRoot,
    sourcemap: sourcemapOptions.scripts && (sourcemapOptions.hidden ? 'external' : true),
    splitting: true,
    tsconfig,
    external: options.externalDependencies,
    write: false,
    platform: 'browser',
    preserveSymlinks: options.preserveSymlinks,
    plugins: [
      createCompilerPlugin(
        // JS/TS options
        {
          sourcemap: !!sourcemapOptions.scripts,
          thirdPartySourcemaps: sourcemapOptions.vendor,
          tsconfig,
          advancedOptimizations: options.buildOptimizer,
          fileReplacements,
        },
        // Component stylesheet options
        {
          workspaceRoot,
          optimization: !!optimizationOptions.styles.minify,
          sourcemap:
            // Hidden component stylesheet sourcemaps are inaccessible which is effectively
            // the same as being disabled. Disabling has the advantage of avoiding the overhead
            // of sourcemap processing.
            !!sourcemapOptions.styles && (sourcemapOptions.hidden ? false : 'inline'),
          outputNames,
          includePaths: options.stylePreprocessorOptions?.includePaths,
          externalDependencies: options.externalDependencies,
          target,
        },
      ),
    ],
    define: {
      ...(optimizationOptions.scripts ? { 'ngDevMode': 'false' } : undefined),
      'ngJitMode': 'false',
    },
  });
}

async function bundleGlobalStylesheets(
  workspaceRoot: string,
  outputNames: { bundles: string; media: string },
  options: BrowserBuilderOptions,
  optimizationOptions: NormalizedOptimizationOptions,
  sourcemapOptions: SourceMapClass,
  target: string[],
) {
  const outputFiles: OutputFile[] = [];
  const initialFiles: FileInfo[] = [];
  const errors: Message[] = [];
  const warnings: Message[] = [];

  // resolveGlobalStyles is temporarily reused from the Webpack builder code
  const { entryPoints: stylesheetEntrypoints, noInjectNames } = normalizeGlobalStyles(
    options.styles || [],
  );

  for (const [name, files] of Object.entries(stylesheetEntrypoints)) {
    const virtualEntryData = files
      .map((file) => `@import '${file.replace(/\\/g, '/')}';`)
      .join('\n');
    const sheetResult = await bundleStylesheetText(
      virtualEntryData,
      { virtualName: `angular:style/global;${name}`, resolvePath: workspaceRoot },
      {
        workspaceRoot,
        optimization: !!optimizationOptions.styles.minify,
        sourcemap: !!sourcemapOptions.styles && (sourcemapOptions.hidden ? 'external' : true),
        outputNames: noInjectNames.includes(name) ? { media: outputNames.media } : outputNames,
        includePaths: options.stylePreprocessorOptions?.includePaths,
        preserveSymlinks: options.preserveSymlinks,
        externalDependencies: options.externalDependencies,
        target,
      },
    );

    errors.push(...sheetResult.errors);
    warnings.push(...sheetResult.warnings);

    if (!sheetResult.path) {
      // Failed to process the stylesheet
      assert.ok(
        sheetResult.errors.length,
        `Global stylesheet processing for '${name}' failed with no errors.`,
      );

      continue;
    }

    // The virtual stylesheets will be named `stdin` by esbuild. This must be replaced
    // with the actual name of the global style and the leading directory separator must
    // also be removed to make the path relative.
    const sheetPath = sheetResult.path.replace('stdin', name);
    let sheetContents = sheetResult.contents;
    if (sheetResult.map) {
      outputFiles.push(createOutputFileFromText(sheetPath + '.map', sheetResult.map));
      sheetContents = sheetContents.replace(
        'sourceMappingURL=stdin.css.map',
        `sourceMappingURL=${name}.css.map`,
      );
    }
    outputFiles.push(createOutputFileFromText(sheetPath, sheetContents));

    if (!noInjectNames.includes(name)) {
      initialFiles.push({
        file: sheetPath,
        name,
        extension: '.css',
      });
    }
    outputFiles.push(...sheetResult.resourceFiles);
  }

  return { outputFiles, initialFiles, errors, warnings };
}

/**
 * Main execution function for the esbuild-based application builder.
 * The options are compatible with the Webpack-based builder.
 * @param initialOptions The browser builder options to use when setting up the application build
 * @param context The Architect builder context object
 * @returns An async iterable with the builder result output
 */
export async function* buildEsbuildBrowser(
  initialOptions: BrowserBuilderOptions,
  context: BuilderContext,
): AsyncIterable<BuilderOutput> {
  // Only AOT is currently supported
  if (initialOptions.aot !== true) {
    context.logger.error(
      'JIT mode is currently not supported by this experimental builder. AOT mode must be used.',
    );

    return { success: false };
  }

  // Inform user of experimental status of builder and options
  logExperimentalWarnings(initialOptions, context);

  // Determine project name from builder context target
  const projectName = context.target?.project;
  if (!projectName) {
    context.logger.error(`The 'browser-esbuild' builder requires a target to be specified.`);

    return { success: false };
  }

  const normalizedOptions = await normalizeOptions(context, projectName, initialOptions);

  // Clean output path if enabled
  if (initialOptions.deleteOutputPath) {
    deleteOutputDir(normalizedOptions.workspaceRoot, initialOptions.outputPath);
  }

  // Create output directory if needed
  try {
    await fs.mkdir(normalizedOptions.outputPath, { recursive: true });
  } catch (e) {
    assertIsError(e);
    context.logger.error('Unable to create output directory: ' + e.message);

    return { success: false };
  }

  // Initial build
  yield await execute(initialOptions, normalizedOptions, context);

  // Finish if watch mode is not enabled
  if (!initialOptions.watch) {
    return;
  }

  // Setup a watcher
  const watcher = createWatcher({
    polling: typeof initialOptions.poll === 'number',
    interval: initialOptions.poll,
    // Ignore the output path to avoid infinite rebuild cycles
    ignored: [normalizedOptions.outputPath],
  });

  // Temporarily watch the entire project
  watcher.add(normalizedOptions.projectRoot);

  // Watch workspace root node modules
  // Includes Yarn PnP manifest files (https://yarnpkg.com/advanced/pnp-spec/)
  watcher.add(path.join(normalizedOptions.workspaceRoot, 'node_modules'));
  watcher.add(path.join(normalizedOptions.workspaceRoot, '.pnp.cjs'));
  watcher.add(path.join(normalizedOptions.workspaceRoot, '.pnp.data.json'));

  // Wait for changes and rebuild as needed
  try {
    for await (const changes of watcher) {
      context.logger.info('Changes detected. Rebuilding...');

      if (initialOptions.verbose) {
        context.logger.info(changes.toDebugString());
      }

      yield await execute(initialOptions, normalizedOptions, context);
    }
  } finally {
    await watcher.close();
  }
}

export default createBuilder(buildEsbuildBrowser);
