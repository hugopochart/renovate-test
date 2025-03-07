import changelogFilenameRegex from 'changelog-filename-regex';
import { logger } from '../../../../../../logger';
import { CacheableGithubReleases } from '../../../../../../modules/datasource/github-releases/cache';
import { CacheableGithubTags } from '../../../../../../modules/datasource/github-tags/cache';
import type {
  GithubGitBlob,
  GithubGitTree,
  GithubGitTreeNode,
} from '../../../../../../types/platform/github';
import { GithubHttp } from '../../../../../../util/http/github';
import { fromBase64 } from '../../../../../../util/string';
import { ensureTrailingSlash } from '../../../../../../util/url';
import type {
  ChangeLogFile,
  ChangeLogNotes,
  ChangeLogProject,
  ChangeLogRelease,
} from '../types';

export const id = 'github-changelog';
const http = new GithubHttp(id);
const tagsCache = new CacheableGithubTags(http);
const releasesCache = new CacheableGithubReleases(http);

export async function getTags(
  endpoint: string,
  repository: string
): Promise<string[]> {
  logger.trace('github.getTags()');
  try {
    const tags = await tagsCache.getItems({
      registryUrl: endpoint,
      packageName: repository,
    });

    // istanbul ignore if
    if (!tags.length) {
      logger.debug({ repository }, 'repository has no Github tags');
    }

    return tags.map(({ version }) => version).filter(Boolean);
  } catch (err) {
    logger.debug(
      { sourceRepo: repository, err },
      'Failed to fetch Github tags'
    );
    // istanbul ignore if
    if (err.message?.includes('Bad credentials')) {
      logger.warn('Bad credentials triggering tag fail lookup in changelog');
      throw err;
    }
    return [];
  }
}

export async function getReleaseNotesMd(
  repository: string,
  apiBaseUrl: string,
  sourceDirectory: string
): Promise<ChangeLogFile | null> {
  logger.trace('github.getReleaseNotesMd()');
  const apiPrefix = `${ensureTrailingSlash(apiBaseUrl)}repos/${repository}`;
  const { default_branch: defaultBranch = 'HEAD' } = (
    await http.getJson<{ default_branch: string }>(apiPrefix)
  ).body;

  // https://docs.github.com/en/rest/reference/git#get-a-tree
  const res = await http.getJson<GithubGitTree>(
    `${apiPrefix}/git/trees/${defaultBranch}${
      sourceDirectory ? '?recursive=1' : ''
    }`
  );

  // istanbul ignore if
  if (res.body.truncated) {
    logger.debug({ repository }, 'Git tree truncated');
  }

  const allFiles = res.body.tree.filter((f) => f.type === 'blob');
  let files: GithubGitTreeNode[] = [];
  if (sourceDirectory?.length) {
    files = allFiles
      .filter((f) => f.path.startsWith(sourceDirectory))
      .filter((f) =>
        changelogFilenameRegex.test(
          f.path.replace(ensureTrailingSlash(sourceDirectory), '')
        )
      );
  }
  if (!files.length) {
    files = allFiles.filter((f) => changelogFilenameRegex.test(f.path));
  }
  if (!files.length) {
    logger.trace('no changelog file found');
    return null;
  }
  const { path: changelogFile, sha } = files.shift()!;
  /* istanbul ignore if */
  if (files.length !== 0) {
    logger.debug(
      `Multiple candidates for changelog file, using ${changelogFile}`
    );
  }

  // https://docs.github.com/en/rest/reference/git#get-a-blob
  const fileRes = await http.getJson<GithubGitBlob>(
    `${apiPrefix}/git/blobs/${sha}`
  );

  const changelogMd = fromBase64(fileRes.body.content) + '\n#\n##';
  return { changelogFile, changelogMd };
}

export async function getReleaseList(
  project: ChangeLogProject,
  _release: ChangeLogRelease
): Promise<ChangeLogNotes[]> {
  logger.trace('github.getReleaseList()');
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const apiBaseUrl = project.apiBaseUrl!;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const repository = project.repository!;
  const notesSourceUrl = `${ensureTrailingSlash(
    apiBaseUrl
  )}repos/${repository}/releases`;
  const items = await releasesCache.getItems({
    registryUrl: apiBaseUrl,
    packageName: repository,
  });
  return items.map(({ url, id, version: tag, name, description: body }) => ({
    url,
    notesSourceUrl,
    id,
    tag,
    name,
    body,
  }));
}
