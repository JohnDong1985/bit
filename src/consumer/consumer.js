/** @flow */
import path from 'path';
import glob from 'glob';
import fs from 'fs-extra';
import flattenDependencies from '../scope/flatten-dependencies';
import { locateConsumer, pathHasConsumer } from './consumer-locator';
import { ConsumerAlreadyExists, ConsumerNotFound } from './exceptions';
import ConsumerBitJson from './bit-json/consumer-bit-json';
import { BitId, BitIds } from '../bit-id';
import Component from './bit-component';
import { 
  INLINE_BITS_DIRNAME,
  BITS_DIRNAME,
  BIT_HIDDEN_DIR,
  DEFAULT_DIST_DIRNAME,
  DEFAULT_BUNDLE_FILENAME,
 } from '../constants';
import { flatten, isEmpty } from '../utils';
import { Scope, ComponentDependencies } from '../scope';
import BitInlineId from './bit-inline-id';
import loadPlugin from './bit-component/environment/load-plugin';

const buildAndSave = (component: Component, scope: Scope, bitDir: string): Promise<Component> =>
  component.build(scope)
  .then((val) => {
    if (!val) return component;

    const { code } = val;
    fs.outputFileSync(
      path.join(bitDir, DEFAULT_DIST_DIRNAME, DEFAULT_BUNDLE_FILENAME),
      code,
    );

    return component;
  });

export type ConsumerProps = {
  projectPath: string,
  created?: boolean,
  bitJson: ConsumerBitJson,
  scope: Scope
};

export default class Consumer {
  projectPath: string;
  created: boolean;
  bitJson: ConsumerBitJson;
  scope: Scope;

  constructor({ projectPath, bitJson, scope, created = false }: ConsumerProps) {
    this.projectPath = projectPath;
    this.bitJson = bitJson;
    this.created = created;
    this.scope = scope;
  }

  write(): Promise<Consumer> {
    return this.bitJson
      .write({ bitDir: this.projectPath })
      .then(() => this.scope.ensureDir())
      .then(() => this);
  }

  getInlineBitsPath(): string {
    return path.join(this.projectPath, INLINE_BITS_DIRNAME);
  }

  getComponentsPath(): string {
    return path.join(this.projectPath, BITS_DIRNAME);
  }

  getPath(): string {
    return this.projectPath;
  }

  loadComponent(id: BitInlineId): Promise<Component> {
    const bitDir = id.composeBitPath(this.getPath());
    return Component.loadFromInline(bitDir, this.bitJson);
  }

  push(rawId: string, rawRemote: string) { 
    // @TODO - move this method to api, not related to consumer
    const bitId = BitId.parse(rawId);
    return this.scope.push(bitId, rawRemote);
  }

  import(rawId: ?string): Component {
    if (!rawId) { // if no arguments inserted, install according to bitJson dependencies
      const deps = BitIds.loadDependencies(this.bitJson.dependencies);
      
      return this.scope.ensureEnvironment({
        testerId: this.bitJson.getTesterName(),
        compilerId: this.bitJson.getCompilerName()
      }).then(() =>
        Promise.all(deps.map(dep => this.scope.get(dep)))
        .then(bits => this.writeToComponentsDir(flatten(bits)))
      );
    }

    const bitId = BitId.parse(rawId);
    return this.scope.get(bitId)
      .then(componentDependencies => this.writeToComponentsDir([componentDependencies]));
  }

  importEnvironment(rawId: ?string) {
    if (!rawId) { throw new Error('you must specify bit id for importing'); } // @TODO - make a normal error message

    const bitId = BitId.parse(rawId);
    return this.scope.get(bitId)
    .then((componentDependencies) => {
      return this.scope.writeToEnvironmentsDir(componentDependencies.component); // @HACKALERT - replace with getOne
    });
  }

  createBit({ id, withSpecs = false, withBitJson = false }: {
    id: BitInlineId, withSpecs: boolean, withBitJson: boolean }): Promise<Component> {
    const inlineBitPath = id.composeBitPath(this.getPath());

    return Component.create({ 
      name: id.name,
      box: id.box,
      withSpecs,
      consumerBitJson: this.bitJson,
    }).write(inlineBitPath, withBitJson);
  }

  removeFromInline(id: BitInlineId): Promise<any> {
    const bitDir = id.composeBitPath(this.getPath());
    return new Promise((resolve, reject) => {
      return fs.remove(bitDir, (err) => {
        if (err) return reject(err);
        return resolve();
      });
    });
  }

  writeToComponentsDir(componentDependencies: ComponentDependencies[]): Promise<Component[]> {
    const componentsDir = this.getComponentsPath();
    // const components = flattenDependencies(componentDependencies);
    if (!componentDependencies || componentDependencies.length === 0) { return Promise.resolve([]); } // HACKALERT - replace when dependencies work
    const components = [componentDependencies[0].component]; // HACKALERT - replace when dependencies work

    const bitDirForConsumerImport = (component: Component) => path.join(
      componentsDir,
      component.box,
      component.name,
      component.scope,
      component.version.toString(),
    );

    return Promise.all(components.map((component) => {
      const bitPath = bitDirForConsumerImport(component);
      return component.write(bitPath, true)
      .then(() => buildAndSave(component, this.scope, bitPath));
    }));
  }

  export(id: BitInlineId) {  
    return this.loadComponent(id)
      .then(bit => this.scope.put(bit))
      .then(bits => this.writeToComponentsDir([bits]))
      .then(() => this.removeFromInline(id));
  }

  testBit(id: BitInlineId): Promise<Component> {
    return this.loadComponent(id)
    .then((bit) => {
      const bitDir = id.composeBitPath(this.getPath());
      return loadPlugin(bit.bitJson.getTesterName())
      .then(tester => tester.test(bitDir));
    });
  }

  listInline(): Promise<Component[]> {
    return new Promise((resolve, reject) =>
      glob(path.join('*', '*'), { cwd: this.getInlineBitsPath() }, (err, files) => {
        if (err) reject(err);

        const bitsP = files.map(bitRawId =>
          this.loadComponent(BitInlineId.parse(bitRawId))
        );

        return Promise.all(bitsP)
        .then(resolve)
        .catch(reject);
      })
    );
  }

  includes({ inline, bitName }: { inline: ?boolean, bitName: string }): Promise<boolean> {
    const dirToCheck = inline ? this.getInlineBitsPath() : this.getComponentsPath();

    return new Promise((resolve) => {
      return fs.stat(path.join(dirToCheck, bitName), (err) => {
        if (err) return resolve(false);
        return resolve(true);
      });
    });
  }

  static create(projectPath: string = process.cwd()): Promise<Consumer> {
    if (pathHasConsumer(projectPath)) throw new ConsumerAlreadyExists();
    const scopeP = Scope.create(path.join(projectPath, BIT_HIDDEN_DIR));

    return scopeP.then(scope => 
      new Consumer({
        projectPath,
        created: true,
        scope,
        bitJson: ConsumerBitJson.create()
      })
    );
  }

  static load(currentPath: string): Promise<Consumer> {
    return new Promise((resolve, reject) => {
      const projectPath = locateConsumer(currentPath);
      if (!projectPath) return reject(new ConsumerNotFound());
      const scopeP = Scope.load(path.join(projectPath, BIT_HIDDEN_DIR));
      const bitJsonP = ConsumerBitJson.load(projectPath);
      return Promise.all([scopeP, bitJsonP])
      .then(([scope, bitJson]) => 
        resolve(
          new Consumer({
            projectPath,
            bitJson,
            scope
          })
        )
      );
    });
  }
}
