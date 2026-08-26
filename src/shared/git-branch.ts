import { z } from 'zod';

export const GitBranchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .refine(
    (value) =>
      !value.includes('..') &&
      !value.includes('//') &&
      !value.includes('@{') &&
      !value.endsWith('/') &&
      !value.endsWith('.') &&
      !value.split('/').some((segment) => segment.length === 0 || segment.endsWith('.lock')),
    'Expected a valid Git branch name',
  );

const branchSlug = (title: string, maximumLength: number): string =>
  title
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, maximumLength);

export const taskBranchName = (
  taskKeyInput: string,
  taskTitle: string,
  maximumLength = 96,
): string => {
  const taskKey = taskKeyInput.toLocaleUpperCase('en-US');
  const available = Math.max(0, maximumLength - taskKey.length - 1);
  const slug = branchSlug(taskTitle, available);
  return slug.length === 0 ? taskKey : `${taskKey}-${slug}`;
};

export const taskBranchNameMatches = (
  branchName: string,
  taskKeyInput: string,
  maximumLength = 96,
): boolean => {
  const parsed = GitBranchNameSchema.safeParse(branchName);
  if (!parsed.success || parsed.data.length > maximumLength) return false;
  const taskKey = taskKeyInput.toLocaleUpperCase('en-US');
  return parsed.data === taskKey || parsed.data.startsWith(`${taskKey}-`);
};
