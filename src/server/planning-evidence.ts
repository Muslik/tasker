import {
  PlanningEvidenceObservationSchema,
  PlanningEvidenceRequestSchema,
  type PlanningEvidenceObservation,
  type PlanningEvidenceRequest,
} from '../planning/index.js';
import { err, type Outcome } from '../shared/outcome.js';

export type PlanningEvidenceReadError =
  | { readonly kind: 'unsupported_skill'; readonly skill: string; readonly retryable: false }
  | {
      readonly kind: 'invalid_locator';
      readonly skill: string;
      readonly locator: string;
      readonly message: string;
      readonly retryable: false;
    }
  | {
      readonly kind: 'reader_unavailable';
      readonly skill: string;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface PlanningEvidenceReader {
  readonly skill: string;
  readonly credentialEnvironment: readonly string[];
  read(
    request: PlanningEvidenceRequest,
  ): Promise<Outcome<PlanningEvidenceObservation, PlanningEvidenceReadError>>;
}

export class PlanningEvidenceReaderRegistry {
  private readonly readers: ReadonlyMap<string, PlanningEvidenceReader>;

  public constructor(readers: readonly PlanningEvidenceReader[]) {
    const bySkill = new Map<string, PlanningEvidenceReader>();
    for (const reader of readers) {
      if (bySkill.has(reader.skill)) {
        throw new Error(`Duplicate planning evidence reader for ${reader.skill}`);
      }
      bySkill.set(reader.skill, reader);
    }
    this.readers = bySkill;
  }

  public supportedSkills(): readonly string[] {
    return [...this.readers.keys()].sort();
  }

  public credentialEnvironment(skills: readonly string[]): readonly string[] {
    const names = new Set<string>();
    for (const skill of skills) {
      for (const name of this.readers.get(skill)?.credentialEnvironment ?? []) names.add(name);
    }
    return [...names].sort();
  }

  public async read(
    requestInput: PlanningEvidenceRequest,
  ): Promise<Outcome<PlanningEvidenceObservation, PlanningEvidenceReadError>> {
    const request = PlanningEvidenceRequestSchema.parse(requestInput);
    const reader = this.readers.get(request.skill);
    if (reader === undefined) {
      return err({ kind: 'unsupported_skill', skill: request.skill, retryable: false });
    }
    const observation = await reader.read(request);
    if (!observation.ok) return observation;
    const parsed = PlanningEvidenceObservationSchema.parse(observation.value);
    if (parsed.skill !== request.skill) {
      return err({
        kind: 'reader_unavailable',
        skill: request.skill,
        message: 'Planning evidence reader returned a different skill than requested',
        retryable: false,
      });
    }
    return { ok: true, value: parsed };
  }
}
