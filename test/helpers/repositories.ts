import { StaticRepositoryCatalog } from '../../src/repositories/catalog.js';
import { RepositoryCatalogEntrySchema } from '../../src/repositories/contracts.js';

export const makeRepositoryCatalog = () =>
  new StaticRepositoryCatalog([
    RepositoryCatalogEntrySchema.parse({
      repositoryId: 'front-avia',
      remoteUrl: 'ssh://git@bitbucket.twiket.com/onetwotrip/front-avia.git',
      checkout: { runnerId: 'test', path: '/work/front-avia' },
      checkoutPaths: ['/work/front-avia', '/work/front-avia-2'],
      aliases: ['front-avia', 'front-avia-2', 'onetwotrip/front-avia'],
    }),
    RepositoryCatalogEntrySchema.parse({
      repositoryId: 'ui-kit',
      remoteUrl: 'ssh://git@bitbucket.twiket.com/twiket/ui-kit.git',
      checkout: { runnerId: 'test', path: '/work/ui-kit' },
      checkoutPaths: ['/work/ui-kit'],
      aliases: ['ui-kit', 'twiket/ui-kit'],
    }),
  ]);
