import type { WorkflowTreeNode } from '../control-plane/m1-contracts.js';

const Node = ({ node }: { readonly node: WorkflowTreeNode }) => (
  <li className="tree-node">
    <article className="tree-node__card">
      <div className="tree-node__kind">
        <span className={`kind kind--${node.kind.replaceAll('_', '-')}`}>{node.kind}</span>
        {node.waitKind === undefined ? null : (
          <span className="wait-icon" aria-label="wait node" title="Durable wait">
            Ⅱ
          </span>
        )}
      </div>
      <div className="tree-node__identity">
        <strong>{node.label}</strong>
        <code>{node.id}</code>
      </div>
      <dl className="tree-node__facts">
        <div>
          <dt>Status</dt>
          <dd>{node.status}</dd>
        </div>
        <div>
          <dt>Retries</dt>
          <dd>{node.retryBudget === null ? '—' : node.retryBudget}</dd>
        </div>
        {node.waitKind === undefined ? null : (
          <div>
            <dt>Wait</dt>
            <dd>{node.waitKind}</dd>
          </div>
        )}
        {node.slotPolicy === undefined ? null : (
          <div>
            <dt>Slot</dt>
            <dd>{node.slotPolicy}</dd>
          </div>
        )}
      </dl>
    </article>
    {node.children.length === 0 ? null : (
      <ol className="workflow-tree workflow-tree--nested">
        {node.children.map((child) => (
          <Node key={child.id} node={child} />
        ))}
      </ol>
    )}
  </li>
);

export const WorkflowTree = ({ root }: { readonly root: WorkflowTreeNode }) => (
  <ol className="workflow-tree" data-testid="workflow-tree">
    <Node node={root} />
  </ol>
);
