import { z } from 'zod';

export const JiraProjectKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/u);

export const HarnessProductManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    title: z.string().min(1),
    jiraProjects: z
      .array(JiraProjectKeySchema)
      .min(1)
      .superRefine((projects, context) => {
        if (new Set(projects).size !== projects.length) {
          context.addIssue({ code: 'custom', message: 'Jira project keys must be unique' });
        }
      }),
    confluence: z
      .object({
        spaceKey: z.string().regex(/^[A-Z][A-Z0-9]*$/u),
        researchRootPageId: z.string().regex(/^\d+$/u),
      })
      .strict(),
    repositories: z
      .object({
        primary: z.string().min(1),
        linked: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();

export type HarnessProductManifest = z.infer<typeof HarnessProductManifestSchema>;
