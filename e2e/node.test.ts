import { execSync, fork, spawn } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import * as treeKill from 'tree-kill';
import * as ts from 'typescript';
import {
  ensureProject,
  readJson,
  runCLI,
  runCLIAsync,
  uniq,
  updateFile,
  forEachCli,
  checkFilesExist,
  tmpProjPath,
  workspaceConfigName,
  cleanup,
  runNew,
  runNgAdd,
  copyMissingPackages,
  setMaxWorkers,
  newProject
} from './utils';

function getData(): Promise<any> {
  return new Promise(resolve => {
    http.get('http://localhost:3333/api', res => {
      expect(res.statusCode).toEqual(200);
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.once('end', () => {
        resolve(JSON.parse(data));
      });
    });
  });
}

forEachCli(currentCLIName => {
  const linter = currentCLIName === 'angular' ? 'tslint' : 'eslint';

  describe('Node Applications', () => {
    it('should be able to generate an express application', async done => {
      ensureProject();
      const nodeapp = uniq('nodeapp');

      runCLI(`generate @nrwl/express:app ${nodeapp} --linter=${linter}`);
      const lintResults = runCLI(`lint ${nodeapp}`);
      expect(lintResults).toContain('All files pass linting.');

      updateFile(
        `apps/${nodeapp}/src/app/test.spec.ts`,
        `
          describe('test', () => {
            it('should work', () => {
              expect(true).toEqual(true);
            })
          })
        `
      );

      updateFile(`apps/${nodeapp}/src/assets/file.txt`, ``);
      const jestResult = await runCLIAsync(`test ${nodeapp}`);
      expect(jestResult.stderr).toContain('Test Suites: 1 passed, 1 total');
      await runCLIAsync(`build ${nodeapp}`);

      checkFilesExist(
        `dist/apps/${nodeapp}/main.js`,
        `dist/apps/${nodeapp}/assets/file.txt`,
        `dist/apps/${nodeapp}/main.js.map`
      );

      const server = fork(`./dist/apps/${nodeapp}/main.js`, [], {
        cwd: tmpProjPath(),
        silent: true
      });
      expect(server).toBeTruthy();
      await new Promise(resolve => {
        server.stdout.once('data', async data => {
          expect(data.toString()).toContain(
            'Listening at http://localhost:3333'
          );
          const result = await getData();

          expect(result.message).toEqual(`Welcome to ${nodeapp}!`);
          treeKill(server.pid, 'SIGTERM', err => {
            expect(err).toBeFalsy();
            resolve();
          });
        });
      });
      const config = readJson(workspaceConfigName());
      config.projects[nodeapp].architect.waitAndPrint = {
        builder: '@nrwl/workspace:run-commands',
        options: {
          commands: [
            {
              command: 'sleep 1 && echo DONE'
            }
          ],
          readyWhen: 'DONE'
        }
      };

      config.projects[nodeapp].architect.serve.options.waitUntilTargets = [
        `${nodeapp}:waitAndPrint`
      ];
      updateFile(workspaceConfigName(), JSON.stringify(config));
      const process = spawn(
        'node',
        ['./node_modules/.bin/nx', 'serve', nodeapp],
        {
          cwd: tmpProjPath()
        }
      );
      let collectedOutput = '';
      process.stdout.on('data', async (data: Buffer) => {
        collectedOutput += data.toString();
        if (!data.toString().includes('Listening at http://localhost:3333')) {
          return;
        }

        const result = await getData();
        expect(result.message).toEqual(`Welcome to ${nodeapp}!`);
        treeKill(process.pid, 'SIGTERM', err => {
          expect(collectedOutput.indexOf('DONE') > -1).toBeTruthy();
          expect(err).toBeFalsy();
          done();
        });
      });
    }, 120000);

    it('should have correct ts options for nest application', async () => {
      if (currentCLIName === 'angular') {
        // Usually the tests use ensureProject() to setup the test workspace. But it will trigger
        // the nx workspace schematic which creates a tsconfig file containing the parameters
        // required by nest.
        // However, when creating an Angular workspace and adding the workspace capability (as
        // described in the docs) the tsconfig file could miss required options if Angular removes
        // them from their config files as happened with emitDecoratorMetadata.
        cleanup();
        runNew('', false, false);
        runNgAdd('add @nrwl/workspace --npmScope projscope --skip-install');
        copyMissingPackages();
      } else {
        ensureProject();
      }

      const nestapp = uniq('nestapp');
      runCLI(`generate @nrwl/nest:app ${nestapp} --linter=${linter}`);
      const configPath = tmpProjPath(`apps/${nestapp}/tsconfig.app.json`);
      const json = ts.readConfigFile(configPath, ts.sys.readFile);
      const config = ts.parseJsonConfigFileContent(
        json.config,
        ts.sys,
        path.dirname(configPath)
      ); // respects "extends" inside tsconfigs

      expect(config.options.emitDecoratorMetadata).toEqual(true); // required by nest to function properly
      expect(config.options.target).toEqual(ts.ScriptTarget.ES2015); // required by nest swagger to function properly
      cleanup();
    }, 120000);

    it('should be able to generate a nest application', async done => {
      ensureProject();
      const nestapp = uniq('nestapp');
      runCLI(`generate @nrwl/nest:app ${nestapp} --linter=${linter}`);

      setMaxWorkers(nestapp);

      const lintResults = runCLI(`lint ${nestapp}`);
      expect(lintResults).toContain('All files pass linting.');

      updateFile(`apps/${nestapp}/src/assets/file.txt`, ``);
      const jestResult = await runCLIAsync(`test ${nestapp}`);
      expect(jestResult.stderr).toContain('Test Suites: 2 passed, 2 total');

      await runCLIAsync(`build ${nestapp}`);

      checkFilesExist(
        `dist/apps/${nestapp}/main.js`,
        `dist/apps/${nestapp}/assets/file.txt`,
        `dist/apps/${nestapp}/main.js.map`
      );

      const server = fork(`./dist/apps/${nestapp}/main.js`, [], {
        cwd: tmpProjPath(),
        silent: true
      });
      expect(server).toBeTruthy();

      await new Promise(resolve => {
        server.stdout.on('data', async data => {
          const message = data.toString();
          if (message.includes('Listening at http://localhost:3333')) {
            const result = await getData();

            expect(result.message).toEqual(`Welcome to ${nestapp}!`);
            treeKill(server.pid, 'SIGTERM', err => {
              expect(err).toBeFalsy();
              resolve();
            });
          }
        });
      });

      const process = spawn(
        'node',
        ['./node_modules/@nrwl/cli/bin/nx', 'serve', nestapp],
        {
          cwd: tmpProjPath()
        }
      );

      process.stdout.on('data', async (data: Buffer) => {
        if (!data.toString().includes('Listening at http://localhost:3333')) {
          return;
        }
        const result = await getData();
        expect(result.message).toEqual(`Welcome to ${nestapp}!`);
        treeKill(process.pid, 'SIGTERM', err => {
          expect(err).toBeFalsy();
          done();
        });
      });
    }, 120000);

    it('should be able to generate an empty application', async () => {
      ensureProject();
      const nodeapp = uniq('nodeapp');

      runCLI(`generate @nrwl/node:app ${nodeapp} --linter=${linter}`);

      setMaxWorkers(nodeapp);

      const lintResults = runCLI(`lint ${nodeapp}`);
      expect(lintResults).toContain('All files pass linting.');

      updateFile(`apps/${nodeapp}/src/main.ts`, `console.log('Hello World!');`);
      await runCLIAsync(`build ${nodeapp}`);

      checkFilesExist(`dist/apps/${nodeapp}/main.js`);
      const result = execSync(`node dist/apps/${nodeapp}/main.js`, {
        cwd: tmpProjPath()
      }).toString();
      expect(result).toContain('Hello World!');
    }, 60000);
  });
  describe('Node Libraries', () => {
    it('should be able to generate a node library', async () => {
      ensureProject();
      const nodelib = uniq('nodelib');

      runCLI(`generate @nrwl/node:lib ${nodelib}`);

      const lintResults = runCLI(`lint ${nodelib}`);
      expect(lintResults).toContain('All files pass linting.');

      const jestResult = await runCLIAsync(`test ${nodelib}`);
      expect(jestResult.stderr).toContain('Test Suites: 1 passed, 1 total');
    }, 60000);

    it('should be able to generate a publishable node library', async () => {
      ensureProject();

      const nodeLib = uniq('nodelib');
      runCLI(`generate @nrwl/node:lib ${nodeLib} --publishable`);
      checkFilesExist(`libs/${nodeLib}/package.json`);
      const tslibConfig = readJson(`libs/${nodeLib}/tsconfig.lib.json`);
      expect(tslibConfig).toEqual({
        extends: './tsconfig.json',
        compilerOptions: {
          module: 'commonjs',
          outDir: '../../dist/out-tsc',
          declaration: true,
          rootDir: './src',
          types: ['node']
        },
        exclude: ['**/*.spec.ts'],
        include: ['**/*.ts']
      });
      await runCLIAsync(`build ${nodeLib}`);
      checkFilesExist(
        `dist/libs/${nodeLib}/index.js`,
        `dist/libs/${nodeLib}/index.d.ts`,
        `dist/libs/${nodeLib}/package.json`
      );

      const packageJson = readJson(`dist/libs/${nodeLib}/package.json`);
      expect(packageJson).toEqual({
        name: `@proj/${nodeLib}`,
        version: '0.0.1',
        main: 'index.js',
        typings: 'index.d.ts'
      });
    }, 60000);

    it('should be able to copy assets', () => {
      ensureProject();
      const nodelib = uniq('nodelib');
      const nglib = uniq('nglib');

      // Generating two libraries just to have a lot of files to copy
      runCLI(`generate @nrwl/node:lib ${nodelib} --publishable`);
      /**
       * The angular lib contains a lot sub directories that would fail without
       * `nodir: true` in the package.impl.ts
       */
      runCLI(`generate @nrwl/angular:lib ${nglib} --publishable`);
      const workspace = readJson(workspaceConfigName());
      workspace.projects[nodelib].architect.build.options.assets.push({
        input: `./dist/libs/${nglib}`,
        glob: '**/*',
        output: '.'
      });

      updateFile(workspaceConfigName(), JSON.stringify(workspace));

      runCLI(`build ${nglib}`);
      runCLI(`build ${nodelib}`);
      checkFilesExist(`./dist/libs/${nodelib}/esm2015/index.js`);
    }, 60000);

    describe('with dependencies', () => {
      beforeAll(() => {
        // force a new project to avoid collissions with the npmScope that has been altered before
        newProject();
      });

      /**
       * Graph:
       *
       *                 childLib
       *               /
       * parentLib =>
       *               \
       *                \
       *                 childLib2
       *
       */
      let parentLib: string;
      let childLib: string;
      let childLib2: string;

      beforeEach(() => {
        parentLib = uniq('parentlib');
        childLib = uniq('childlib');
        childLib2 = uniq('childlib2');

        ensureProject();

        runCLI(`generate @nrwl/node:lib ${parentLib} --publishable=true`);
        runCLI(`generate @nrwl/node:lib ${childLib} --publishable=true`);
        runCLI(`generate @nrwl/node:lib ${childLib2} --publishable=true`);

        // create dependencies by importing
        const createDep = (parent, children: string[]) => {
          updateFile(
            `libs/${parent}/src/lib/${parent}.ts`,
            `
                ${children
                  .map(entry => `import { ${entry} } from '@proj/${entry}';`)
                  .join('\n')}

                export function ${parent}(): string {
                  return '${parent}' + ' ' + ${children
              .map(entry => `${entry}()`)
              .join('+')}
                }
                `
          );
        };

        createDep(parentLib, [childLib, childLib2]);
      });

      it('should throw an error if the dependent library has not been built before building the parent lib', () => {
        expect.assertions(2);

        try {
          runCLI(`build ${parentLib}`);
        } catch (e) {
          expect(e.stderr.toString()).toContain(
            `Some of the project ${parentLib}'s dependencies have not been built yet. Please build these libraries before:`
          );
          expect(e.stderr.toString()).toContain(`${childLib}`);
        }
      });

      it('should build a library without dependencies', () => {
        const childLibOutput = runCLI(`build ${childLib}`);

        expect(childLibOutput).toContain(
          `Done compiling TypeScript files for library ${childLib}`
        );
      });

      it('should build a parent library if the dependent libraries have been built before', () => {
        const childLibOutput = runCLI(`build ${childLib}`);
        expect(childLibOutput).toContain(
          `Done compiling TypeScript files for library ${childLib}`
        );

        const childLib2Output = runCLI(`build ${childLib2}`);
        expect(childLib2Output).toContain(
          `Done compiling TypeScript files for library ${childLib2}`
        );

        const parentLibOutput = runCLI(`build ${parentLib}`);
        expect(parentLibOutput).toContain(
          `Done compiling TypeScript files for library ${parentLib}`
        );

        //   assert package.json deps have been set
        const assertPackageJson = (
          parent: string,
          lib: string,
          version: string
        ) => {
          const jsonFile = readJson(`dist/libs/${parent}/package.json`);
          const childDependencyVersion = jsonFile.dependencies[`@proj/${lib}`];
          expect(childDependencyVersion).toBe(version);
        };

        assertPackageJson(parentLib, childLib, '0.0.1');
        assertPackageJson(parentLib, childLib2, '0.0.1');
      });

      // it('should automatically build all deps and update package.json when passing --withDeps flags', () => {
      //   const parentLibOutput = runCLI(`build ${parentLib} --withDeps`);

      //   expect(parentLibOutput).toContain(
      //     `Done compiling TypeScript files for library ${parentLib}`
      //   );
      //   expect(parentLibOutput).toContain(
      //     `Done compiling TypeScript files for library ${childLib}`
      //   );
      //   expect(parentLibOutput).toContain(
      //     `Done compiling TypeScript files for library ${childChildLib}`
      //   );
      //   expect(parentLibOutput).toContain(
      //     `Done compiling TypeScript files for library ${childLib2}`
      //   );
      //   expect(parentLibOutput).toContain(
      //     `Done compiling TypeScript files for library ${childLibShared}`
      //   );

      //   //   // assert package.json deps have been set
      //   const assertPackageJson = (
      //     parent: string,
      //     lib: string,
      //     version: string
      //   ) => {
      //     const jsonFile = readJson(`dist/libs/${parent}/package.json`);
      //     const childDependencyVersion =
      //       jsonFile.dependencies[`@proj/${lib}`];
      //     expect(childDependencyVersion).toBe(version);
      //   };

      //   assertPackageJson(parentLib, childLib, '0.0.1');
      //   assertPackageJson(childLib, childChildLib, '0.0.1');
      //   assertPackageJson(childLib, childLibShared, '0.0.1');
      //   assertPackageJson(childLib2, childLibShared, '0.0.1');
      // });
    });
  });
});
