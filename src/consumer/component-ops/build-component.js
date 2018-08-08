import path from 'path';
import Vinyl from 'vinyl';
import Dists from '../component/sources/dists';
import ConsumerComponent from '../component/consumer-component';
import { Scope } from '../../scope';
import InvalidCompilerInterface from '../component/exceptions/invalid-compiler-interface';
import IsolatedEnvironment from '../../environment';
import ComponentMap from '../bit-map/component-map';
import { BitId } from '../../bit-id';
import logger from '../../logger/logger';
import { COMPONENT_ORIGINS, DEFAULT_DIST_DIRNAME } from '../../constants';
import ExternalBuildError from '../component/exceptions/external-build-error';
import Consumer from '../consumer';
import type { PathLinux } from '../../utils/path';
import { isString } from '../../utils';
import GeneralError from '../../error/general-error';
import { Dist } from '../component/sources';

// @flow

export default (async function buildComponent({
  component,
  scope,
  save,
  consumer,
  noCache,
  verbose,
  keep
}: {
  component: ConsumerComponent,
  scope: Scope,
  save?: boolean,
  consumer?: Consumer,
  noCache?: boolean,
  verbose?: boolean,
  keep?: boolean
}): Promise<?Dists> {
  logger.debug(`consumer-component.build ${component.id.toString()}`);
  // @TODO - write SourceMap Type
  if (!component.compiler) {
    if (!consumer || consumer.shouldDistsBeInsideTheComponent()) {
      logger.debug('compiler was not found, nothing to build');
      return null;
    }
    logger.debug(
      'compiler was not found, however, because the dists are set to be outside the components directory, save the source file as dists'
    );
    component.copyFilesIntoDists();
    return component.dists;
  }

  const bitMap = consumer ? consumer.bitMap : undefined;
  const consumerPath = consumer ? consumer.getPath() : '';
  const componentMap = bitMap && bitMap.getComponentIfExist(component.id);
  let componentDir = consumerPath;
  if (componentMap) {
    componentDir = consumerPath && componentMap.rootDir ? path.join(consumerPath, componentMap.rootDir) : undefined;
  }
  const needToRebuild = await _isNeededToReBuild(consumer, component.id, noCache);
  if (!needToRebuild && !component.dists.isEmpty()) {
    logger.debug('skip the build process as the component was not modified, use the dists saved in the model');
    if (componentMap && componentMap.origin === COMPONENT_ORIGINS.IMPORTED) {
      component.stripOriginallySharedDir(bitMap);
      // don't worry about the dist.entry and dist.target at component point. It'll be done later on once the files are
      // written, probably by component.dists.writeDists()
    }

    return component.dists;
  }
  logger.debug('compiler found, start building');
  if (component.compiler && !component.compiler.loaded) {
    await component.compiler.install(
      scope,
      { verbose: !!verbose },
      { workspaceDir: consumerPath, componentDir, dependentId: component.id }
    );
  }

  const builtFiles =
    (await _buildIfNeeded({
      component,
      consumer,
      componentMap,
      scope,
      keep,
      verbose: !!verbose
    })) || [];
  // return buildFilesP.then((buildedFiles) => {
  builtFiles.forEach((file) => {
    if (file && (!file.contents || !isString(file.contents.toString()))) {
      throw new GeneralError('builder interface has to return object with a code attribute that contains string');
    }
  });
  component.setDists(builtFiles.map(file => new Dist(file)));

  if (save) {
    await scope.sources.updateDist({ source: component });
  }
  return component.dists;
});

async function _buildIfNeeded({
  component,
  consumer,
  componentMap,
  scope,
  verbose,
  directory,
  keep
}: {
  component: ConsumerComponent,
  consumer?: Consumer,
  componentMap?: ?ComponentMap,
  scope: Scope,
  verbose: boolean,
  directory?: ?string,
  keep: ?boolean
}): Promise<Vinyl[]> {
  const compiler = component.compiler;

  if (!compiler) {
    throw new GeneralError('compiler was not found, nothing to build');
  }

  if (!compiler.action && !compiler.oldAction) {
    throw new InvalidCompilerInterface(compiler.name);
  }

  if (consumer) return _runBuild({ component, componentRoot: consumer.getPath(), consumer, componentMap });
  if (component.isolatedEnvironment) {
    return _runBuild({ component, componentRoot: component.writtenPath, consumer, componentMap });
  }

  const isolatedEnvironment = new IsolatedEnvironment(scope, directory);
  try {
    await isolatedEnvironment.create();
    const isolateOpts = {
      verbose,
      installPackages: true,
      noPackageJson: false
    };
    const componentWithDependencies = await isolatedEnvironment.isolateComponent(component.id, isolateOpts);
    const isolatedComponent = componentWithDependencies.component;
    const result = await _runBuild({ component, componentRoot: isolatedComponent.writtenPath, consumer, componentMap });
    if (!keep) await isolatedEnvironment.destroy();
    return result;
  } catch (err) {
    await isolatedEnvironment.destroy();
    throw err;
  }
}

// Ideally it's better to use the dists from the model.
// If there is no consumer, it comes from the scope or isolated environment, which the dists are already saved.
// If there is consumer, check whether the component was modified. If it wasn't, no need to re-build.
const _isNeededToReBuild = async (consumer: Consumer, componentId: BitId, noCache: ?boolean): Promise<boolean> => {
  // Forcly rebuild
  if (noCache) return true;
  if (!consumer) return false;
  const componentStatus = await consumer.getComponentStatusById(componentId);
  return componentStatus.modified;
};

const _runBuild = async ({
  component,
  componentRoot,
  consumer,
  componentMap
}: {
  component: ConsumerComponent,
  componentRoot: PathLinux,
  consumer: ?Consumer,
  componentMap: ComponentMap
}): Promise<Vinyl[]> => {
  const compiler = component.compiler;
  if (!compiler) {
    throw new GeneralError('compiler was not found, nothing to build');
  }

  let rootDistFolder = path.join(componentRoot, DEFAULT_DIST_DIRNAME);
  const consumerPath = consumer ? consumer.getPath() : '';
  const files = component.files.map(file => file.clone());

  let componentDir = '';
  if (componentMap) {
    // $FlowFixMe
    rootDistFolder = component.dists.getDistDirForConsumer(consumer, componentMap.rootDir);
    if (consumerPath && componentMap && componentMap.getTrackDir()) {
      componentDir = componentMap.getTrackDir() || '';
    }
  }
  return Promise.resolve()
    .then(async () => {
      if (!compiler.action && !compiler.oldAction) {
        throw new InvalidCompilerInterface(compiler.name);
      }

      const context: Object = {
        componentObject: component.toObject(),
        rootDistFolder,
        componentDir
      };

      // Change the cwd to make sure we found the needed files
      process.chdir(componentRoot);
      if (compiler.action) {
        const actionParams = {
          files,
          rawConfig: compiler.rawConfig,
          dynamicConfig: compiler.dynamicConfig,
          configFiles: compiler.files,
          api: compiler.api,
          context
        };
        const result = await compiler.action(actionParams);
        // TODO: Gilad - handle return of main dist file
        if (!result || !result.files) {
          throw new Error('compiler return invalid response');
        }
        return result.files;
      }
      if (!compiler.oldAction) {
        throw new InvalidCompilerInterface(compiler.name);
      }
      return compiler.oldAction(files, rootDistFolder, context);
    })
    .catch((e) => {
      throw new ExternalBuildError(e, component.id.toString());
    });
};
