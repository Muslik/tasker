import { describe, expect, it } from 'vitest';

import { JiraIssueSnapshotSchema } from '../../../src/integrations/jira/contracts.js';
import { makeJiraSnapshot } from '../../helpers/jira.js';

describe('Jira issue snapshot contracts', () => {
  it('requires stable Jira link identity in every stored link snapshot', () => {
    const snapshot = makeJiraSnapshot();
    const invalid = {
      ...snapshot,
      links: snapshot.links.map((link) =>
        Object.fromEntries(Object.entries(link).filter(([key]) => key !== 'linkId')),
      ),
    };

    expect(() => JiraIssueSnapshotSchema.parse(invalid)).toThrow(/"linkId"/u);
  });
});
