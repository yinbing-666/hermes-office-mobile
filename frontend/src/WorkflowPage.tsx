import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { OfficeIcon, type OfficeIconName } from './components/OfficeIcon';

type WorkflowNodeType = 'start' | 'llm' | 'tool' | 'weixin' | 'condition' | 'hermes_call' | 'end';

type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  x: number;
  y: number;
  label: string;
  prompt?: string;
  config?: Record<string, unknown>;
};

type WorkflowEdge = {
  id: string;
  from: string;
  to: string;
  fromPort?: 'output';
  toPort?: 'input';
};

type NodeMeta = {
  label: string;
  shortLabel: string;
  icon: OfficeIconName;
  accent: string;
  hint: string;
  prompt?: string;
  config?: Record<string, unknown>;
};

const GRID_SIZE = 24;
const STORAGE_NODES = 'workflow-nodes-v4';
const STORAGE_EDGES = 'workflow-edges-v4';
const BUTTON_DEBOUNCE_MS = 400;
const LOG_LIMIT = 80;

const COLORS = {
  success: '#2f9b68',
  info: '#477fac',
  tool: '#9e6c00',
  weixin: '#1e88e5',
  condition: '#8e24aa',
  hermes: '#e64a19',
  danger: '#b3261e',
  edge: '#8b9bad',
} as const;

const nodeMeta: Record<WorkflowNodeType, NodeMeta> = {
  start: { label: '开始', shortLabel: '开始', icon: 'activity', accent: COLORS.success, hint: '工作流入口' },
  llm: { label: 'LLM 调用', shortLabel: 'LLM', icon: 'terminal', accent: COLORS.info, hint: '写入 Prompt 或 Skill 名称', prompt: '在这里输入 Prompt 或 Skill 名称' },
  tool: { label: '工具调用', shortLabel: '工具', icon: 'database', accent: COLORS.tool, hint: '外部工具执行' },
  weixin: { label: '微信 Gateway', shortLabel: '微信', icon: 'message', accent: COLORS.weixin, hint: '本地 Hermes 网关', config: { account: 'local-hermes', action: 'send' } },
  condition: { label: '条件分支', shortLabel: '条件', icon: 'refresh', accent: COLORS.condition, hint: '条件判断节点' },
  hermes_call: { label: 'Hermes 调用', shortLabel: 'Hermes', icon: 'workspace', accent: COLORS.hermes, hint: '调用 Hermes Skill', prompt: '在这里输入 Prompt 或 Skill 名称' },
  end: { label: '结束', shortLabel: '结束', icon: 'check', accent: COLORS.danger, hint: '工作流结束' },
};

const initialNodes: WorkflowNode[] = [
  {
    id: '1',
    type: 'start',
    x: 120,
    y: 120,
    label: '开始',
  },
];

const nodePalette: WorkflowNodeType[] = ['start', 'llm', 'tool', 'weixin', 'condition', 'hermes_call', 'end'];

function createNode(type: WorkflowNodeType, x: number, y: number): WorkflowNode {
  const meta = nodeMeta[type];
  return {
    id: `${type}-${Date.now()}`,
    type,
    x: Math.round(x / GRID_SIZE) * GRID_SIZE,
    y: Math.round(y / GRID_SIZE) * GRID_SIZE,
    label: meta.label,
    prompt: meta.prompt,
    config: meta.config,
  };
}

function readWorkflowStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function clampNodePosition(x: number, y: number) {
  return {
    x: Math.max(32, x),
    y: Math.max(32, y),
  };
}

type WorkflowExecutionPlan = {
  nodes: WorkflowNode[];
  errors: string[];
  warnings: string[];
};

function buildWorkflowExecutionPlan(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowExecutionPlan {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, string[]>();
  const validEdges = edges.filter((edge) => nodeById.has(edge.from) && nodeById.has(edge.to));
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const node of nodes) adjacency.set(node.id, []);
  if (validEdges.length !== edges.length) {
    warnings.push('已忽略指向不存在节点的连线');
  }
  for (const edge of validEdges) {
    adjacency.get(edge.from)?.push(edge.to);
  }

  const startNodes = nodes.filter((node) => node.type === 'start');
  const endNodes = nodes.filter((node) => node.type === 'end');
  if (startNodes.length === 0) errors.push('无法运行：缺少开始节点');
  if (startNodes.length > 1) errors.push('无法运行：只能有一个开始节点');
  if (endNodes.length === 0) errors.push('无法运行：缺少结束节点');
  if (errors.length > 0) return { nodes: [], errors, warnings };

  const startNode = startNodes[0];
  const reachable = new Set<string>();
  const pending = [startNode.id];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || reachable.has(current)) continue;
    reachable.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }

  const isolatedNodes = nodes.filter((node) => !reachable.has(node.id));
  if (isolatedNodes.length > 0) {
    warnings.push(`忽略 ${isolatedNodes.length} 个未从开始节点连通的孤立节点`);
  }
  if (!reachable.has(endNodes[0].id)) {
    errors.push('无法运行：结束节点不在开始节点可达路径上');
  }

  const indegree = new Map<string, number>();
  for (const nodeId of reachable) indegree.set(nodeId, 0);
  for (const edge of validEdges) {
    if (reachable.has(edge.from) && reachable.has(edge.to)) {
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }
  }

  const queue = nodes
    .filter((node) => reachable.has(node.id) && indegree.get(node.id) === 0)
    .map((node) => node.id);
  const orderedIds: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    orderedIds.push(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!reachable.has(next)) continue;
      const nextIndegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextIndegree);
      if (nextIndegree === 0) queue.push(next);
    }
  }
  if (orderedIds.length !== reachable.size) {
    errors.push('无法运行：开始节点可达路径中存在环路');
  }

  return {
    nodes: orderedIds.map((id) => nodeById.get(id)).filter((node): node is WorkflowNode => Boolean(node)),
    errors,
    warnings,
  };
}

function WorkflowLoadingState() {
  return (
    <section className="page-section workflow-page">
      <div className="workflow-loading-card">
        <OfficeIcon name="workflow" size={22} />
        <div>
          <strong>正在加载工作流画布</strong>
          <small>工作流编辑器已拆分为独立模块，按需加载以减轻首屏压力。</small>
        </div>
      </div>
    </section>
  );
}

export function WorkflowPage() {
  const [nodes, setNodes] = useState<WorkflowNode[]>(() => readWorkflowStorage(STORAGE_NODES, initialNodes));
  const [edges, setEdges] = useState<WorkflowEdge[]>(() => readWorkflowStorage(STORAGE_EDGES, []));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectFromId, setConnectFromId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentRunningNode, setCurrentRunningNode] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const buttonDebounceRef = useRef<Record<string, number>>({});
  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);

  const snapToGrid = useCallback((pos: number) => Math.round(pos / GRID_SIZE) * GRID_SIZE, []);

  const addToLog = useCallback((message: string) => {
    setLog((current) => [...current, `[${new Date().toLocaleTimeString()}] ${message}`].slice(-LOG_LIMIT));
  }, []);

  const handleDebouncedButtonClick = useCallback((key: string, action: () => void | Promise<void>) => {
    const now = Date.now();
    const lastClick = buttonDebounceRef.current[key] ?? 0;
    if (now - lastClick < BUTTON_DEBOUNCE_MS) return;
    buttonDebounceRef.current[key] = now;
    void action();
  }, []);

  const addNode = useCallback((type: WorkflowNodeType, x: number, y: number) => {
    const newNode = createNode(type, x, y);
    setNodes((current) => [...current, newNode]);
    addToLog(`添加节点：${newNode.label}`);
  }, [addToLog]);

  const addNodeFromPalette = useCallback((type: WorkflowNodeType) => {
    const centerX = canvasSize.width ? Math.max(60, canvasSize.width * 0.42) : 160;
    const centerY = canvasSize.height ? Math.max(60, canvasSize.height * 0.24) : 140;
    addNode(type, centerX, centerY);
  }, [addNode, canvasSize]);

  const updateNode = useCallback((id: string, updates: Partial<WorkflowNode>) => {
    setNodes((current) => current.map((node) => (node.id === id ? { ...node, ...updates } : node)));
  }, []);

  const deleteNode = useCallback((id: string) => {
    if (!window.confirm('确定删除此节点？')) return;
    setNodes((current) => current.filter((node) => node.id !== id));
    setEdges((current) => current.filter((edge) => edge.from !== id && edge.to !== id));
    if (selectedNodeId === id) setSelectedNodeId(null);
    addToLog(`删除节点 ${id}`);
  }, [addToLog, selectedNodeId]);

  const addEdge = useCallback((from: string, to: string) => {
    if (from === to) {
      addToLog('拒绝连线：不能连接节点自身');
      return;
    }
    if (edges.some((edge) => edge.from === from && edge.to === to)) {
      addToLog('拒绝连线：相同连线已经存在');
      return;
    }
    setEdges((current) => {
      if (current.some((edge) => edge.from === from && edge.to === to)) return current;
      return [...current, { id: `edge-${from}-${to}-${Date.now()}`, from, to }];
    });
    addToLog(`创建连线：${from} → ${to}`);
  }, [addToLog, edges]);

  const runWorkflow = useCallback(async () => {
    if (isRunning) return;
    setIsRunning(true);
    setLog([]);

    try {
      addToLog('模拟运行开始：不会真正调用 Hermes');

      const plan = buildWorkflowExecutionPlan(nodes, edges);
      plan.warnings.forEach((warning) => addToLog(`工作流提示：${warning}`));
      if (plan.errors.length > 0) {
        plan.errors.forEach((error) => addToLog(error));
        return;
      }
      addToLog(`执行路径：${plan.nodes.map((node) => node.label).join(' → ')}`);

      for (const node of plan.nodes) {
        setCurrentRunningNode(node.id);
        addToLog(`模拟节点 ${node.label} (${node.type})`);

        if (node.type === 'weixin') {
          addToLog('模拟：微信 Gateway 节点（未真实调用）');
        } else if (node.type === 'hermes_call') {
          addToLog(`模拟：Hermes 调用 ${node.prompt || 'default'}（未真实调用）`);
        } else if (node.type === 'llm') {
          addToLog(`模拟：LLM Prompt ${node.prompt?.substring(0, 35) || ''}...（未真实调用）`);
        } else if (node.type === 'condition') {
          addToLog('模拟：条件判断通过');
        }

        await new Promise((resolve) => setTimeout(resolve, 280));
      }

      addToLog('模拟运行完成：当前 mode=simulated（不会调用 Hermes / outbox）');
    } finally {
      setCurrentRunningNode(null);
      setIsRunning(false);
    }
  }, [addToLog, edges, isRunning, nodes]);

  const exportWorkflow = useCallback(() => {
    const data = { nodes, edges, version: 'v4' };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'workflow-v4.json';
    link.click();
    URL.revokeObjectURL(url);
    addToLog('工作流已导出为 JSON');
  }, [addToLog, edges, nodes]);

  const importWorkflow = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (loadEvent) => {
        try {
          const data = JSON.parse(String(loadEvent.target?.result));
          if (data.nodes) setNodes(data.nodes);
          if (data.edges) setEdges(data.edges);
          addToLog('工作流导入成功 (v4)');
        } catch {
          addToLog('导入失败：JSON 格式错误');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, [addToLog]);

  const onCanvasClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!canvasRef.current || selectedNodeId || isConnecting || isDragging) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    addNode('llm', x, y);
  }, [addNode, isConnecting, isDragging, selectedNodeId]);

  const onNodePointerDown = useCallback((id: string, event: ReactPointerEvent, isPort = false) => {
    event.stopPropagation();
    if (isPort) {
      setIsConnecting(true);
      setConnectFromId(id);
      addToLog(`开始从 ${id} 端口拖拽连线`);
      return;
    }
    setSelectedNodeId(id);
    setDragNodeId(id);
    setIsDragging(true);
  }, [addToLog]);

  const onCanvasPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (isDragging && dragNodeId && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const next = clampNodePosition(
        snapToGrid(event.clientX - rect.left - 70),
        snapToGrid(event.clientY - rect.top - 30),
      );
      updateNode(dragNodeId, next);
    }
  }, [dragNodeId, isDragging, snapToGrid, updateNode]);

  const onCanvasPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (isConnecting && connectFromId && canvasRef.current) {
      const hitTarget = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-workflow-input-port]');
      const targetId = hitTarget?.dataset.nodeId;
      if (targetId) {
        addEdge(connectFromId, targetId);
      } else {
        addToLog('连线已取消：请松开在目标节点的输入端口');
      }
      setIsConnecting(false);
      setConnectFromId(null);
    }
    setIsDragging(false);
    setDragNodeId(null);
  }, [addEdge, addToLog, connectFromId, isConnecting]);

  const onCanvasPointerLeave = useCallback(() => {
    if (isConnecting && connectFromId) {
      addToLog('连线已取消：未命中目标输入端口');
    }
    setIsConnecting(false);
    setConnectFromId(null);
    setIsDragging(false);
    setDragNodeId(null);
  }, [addToLog, connectFromId, isConnecting]);

  const onDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('text/plain') as WorkflowNodeType;
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    addNode(type, event.clientX - rect.left, event.clientY - rect.top);
  }, [addNode]);

  useEffect(() => {
    const handleResize = () => {
      if (!canvasRef.current) return;
      setCanvasSize({
        width: canvasRef.current.clientWidth,
        height: canvasRef.current.clientHeight,
      });
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_NODES, JSON.stringify(nodes));
    window.localStorage.setItem(STORAGE_EDGES, JSON.stringify(edges));
  }, [edges, nodes]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Delete' && selectedNodeId) {
        deleteNode(selectedNodeId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteNode, selectedNodeId]);

  useEffect(() => {
    if (!selectedNodeId) return;
    if (!nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [nodes, selectedNodeId]);

  return (
    <section className="page-section workflow-page">
      <header className="workflow-header">
        <div className="workflow-title-block">
          <p className="eyebrow">Workflow Studio</p>
          <h1>工作流</h1>
          <p>拖拽、连线、查看日志的本地工作流画布，优先适配手机 WebView。</p>
        </div>
        <div className="workflow-header-meta">
          <span><OfficeIcon name="workflow" size={16} /> 模拟模式</span>
          <span><OfficeIcon name="database" size={16} /> 本地存草稿</span>
        </div>
      </header>

      <div className="workflow-toolbar" aria-label="工作流工具栏">
        <button className="workflow-primary-button" type="button" onClick={() => handleDebouncedButtonClick('run', runWorkflow)} disabled={isRunning} aria-describedby="workflow-simulation-notice">
          <OfficeIcon name={isRunning ? 'clock' : 'workflow'} size={16} />
          {isRunning ? '模拟中…' : '模拟运行'}
        </button>
        <button className="workflow-secondary-button" type="button" onClick={() => handleDebouncedButtonClick('export', exportWorkflow)}>
          <OfficeIcon name="file" size={16} />
          导出 JSON
        </button>
        <button className="workflow-secondary-button" type="button" onClick={() => handleDebouncedButtonClick('import', importWorkflow)}>
          <OfficeIcon name="refresh" size={16} />
          导入 JSON
        </button>
        <button
          className="workflow-danger-button"
          type="button"
          onClick={() => handleDebouncedButtonClick('clear', () => {
            if (!window.confirm('确定清空当前工作流草稿？此操作会删除本地节点和连线。')) return;
            setNodes(initialNodes);
            setEdges([]);
            setLog([]);
            window.localStorage.removeItem(STORAGE_NODES);
            window.localStorage.removeItem(STORAGE_EDGES);
          })}
        >
          <OfficeIcon name="alert" size={16} />
          清空画布
        </button>
      </div>

      <div className="workflow-simulation-notice" id="workflow-simulation-notice" role="status">
        <OfficeIcon name="alert" size={16} />
        <span>当前仅本地模拟，不会调用 Hermes，也不会写入 outbox。</span>
      </div>
      <div className="workflow-mode-pill">拖拽左侧节点到画布 · 从端口拖拽连线 · Delete 删除选中节点</div>

      <div className="workflow-layout">
        <aside className="workflow-library" aria-label="节点库">
          <div className="workflow-panel-head">
            <div>
              <p>Node Library</p>
              <strong>节点库</strong>
            </div>
            <span>v4</span>
          </div>
          <div className="workflow-palette">
            {nodePalette.map((type) => {
              const meta = nodeMeta[type];
              return (
                <button
                  key={type}
                  type="button"
                  className="workflow-palette-button"
                  draggable
                  onClick={() => handleDebouncedButtonClick(`palette-${type}`, () => addNodeFromPalette(type))}
                  onDragStart={(event) => event.dataTransfer.setData('text/plain', type)}
                >
                  <span className="workflow-palette-icon" style={{ color: meta.accent }}><OfficeIcon name={meta.icon} size={18} /></span>
                  <span className="workflow-palette-copy">
                    <strong>{meta.shortLabel}</strong>
                    <small>{meta.hint}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <div
          ref={canvasRef}
          className="workflow-canvas-shell"
          onClick={onCanvasClick}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerLeave={onCanvasPointerLeave}
          onPointerCancel={onCanvasPointerLeave}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          <div className="workflow-canvas-grid" aria-hidden="true" />
          <svg className="workflow-edges" strokeLinecap="round" aria-hidden="true">
            {edges.map((edge) => {
              const fromNode = nodes.find((node) => node.id === edge.from);
              const toNode = nodes.find((node) => node.id === edge.to);
              if (!fromNode || !toNode) return null;

              const x1 = fromNode.x + 170;
              const y1 = fromNode.y + 38;
              const x2 = toNode.x + 8;
              const y2 = toNode.y + 38;
              const cp1x = x1 + 60;
              const cp1y = y1;
              const cp2x = x2 - 60;
              const cp2y = y2;

              return (
                <g key={edge.id}>
                  <path
                    d={`M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`}
                    stroke={COLORS.edge}
                    strokeWidth="3.5"
                    fill="none"
                    strokeDasharray="6 2"
                  />
                  <circle cx={x2} cy={y2} r="5" fill={COLORS.info} />
                </g>
              );
            })}
          </svg>

          {nodes.map((node) => {
            const meta = nodeMeta[node.type];
            const isSelected = selectedNodeId === node.id;
            const isRunningNode = currentRunningNode === node.id;
            return (
              <article
                key={node.id}
                className={`workflow-node ${isSelected ? 'selected' : ''} ${isRunningNode ? 'running' : ''}`}
                style={{ left: node.x, top: node.y, borderColor: meta.accent }}
                onPointerDown={(event) => onNodePointerDown(node.id, event)}
              >
                <button
                  className="workflow-node-delete"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleDebouncedButtonClick(`delete-node-${node.id}`, () => deleteNode(node.id));
                  }}
                  aria-label={`删除 ${node.label}`}
                >
                  ×
                </button>
                <div className="workflow-node-icon" style={{ color: meta.accent }}>
                  <OfficeIcon name={meta.icon} size={18} />
                </div>
                <div className="workflow-node-copy">
                  <strong>{node.label}</strong>
                  <small>{meta.hint}</small>
                </div>
                <button
                  className="workflow-port output"
                  type="button"
                  onPointerDown={(event) => onNodePointerDown(node.id, event, true)}
                  aria-label={`从 ${node.label} 输出端拖拽连线`}
                />
                <button
                  className="workflow-port input"
                  type="button"
                  data-workflow-input-port
                  data-node-id={node.id}
                  aria-label={`连接到 ${node.label}`}
                  onPointerDown={(event) => event.stopPropagation()}
                />
              </article>
            );
          })}

          <div className="workflow-canvas-caption">
            <span>拖拽左侧节点到画布 · 从右侧端口拖拽连线 · 网格吸附已启用</span>
            <strong>Workflow v4 · 模拟模式 · 未调用 Hermes</strong>
          </div>
        </div>

        <aside className="workflow-inspector">
          <div className="workflow-panel-head">
            <div>
              <p>Inspector</p>
              <strong>节点属性</strong>
            </div>
            <span>{selectedNode ? selectedNode.type : '未选中'}</span>
          </div>

          {selectedNode ? (
            <div className="workflow-inspector-body">
              <label>
                <span>节点名称</span>
                <input
                  value={selectedNode.label}
                  onChange={(event) => updateNode(selectedNode.id, { label: event.target.value })}
                  placeholder="节点标题"
                />
              </label>

              {(selectedNode.type === 'llm' || selectedNode.type === 'hermes_call') ? (
                <label>
                  <span>Prompt / Skill</span>
                  <textarea
                    value={selectedNode.prompt || ''}
                    onChange={(event) => updateNode(selectedNode.id, { prompt: event.target.value })}
                    placeholder="输入 Prompt 或 Hermes Skill 名称..."
                  />
                </label>
              ) : null}

              {selectedNode.type === 'weixin' ? (
                <div className="workflow-inspector-note">
                  已连接本地 Hermes Weixin Gateway
                  <small>当前账号：local-hermes</small>
                </div>
              ) : null}

              <div className="workflow-inspector-actions">
                <button className="workflow-danger-button" type="button" onClick={() => handleDebouncedButtonClick(`delete-selected-${selectedNode.id}`, () => deleteNode(selectedNode.id))}>
                  <OfficeIcon name="alert" size={16} />
                  删除此节点
                </button>
              </div>
            </div>
          ) : (
            <div className="workflow-empty-state">
              <OfficeIcon name="workflow" size={20} />
              <strong>点击任意节点编辑属性</strong>
              <small>选中节点后可修改名称、Prompt、或删除节点。</small>
            </div>
          )}

          <div className="workflow-log-card">
            <div className="workflow-panel-head compact">
              <div>
                <p>Execution Log</p>
                <strong>执行日志</strong>
              </div>
              <span>实时</span>
            </div>
            <div className="workflow-log-list">
              {log.length > 0 ? log.map((item) => <div key={item}>{item}</div>) : <div className="workflow-log-empty">点击“模拟运行”开始本地模拟，不会调用 Hermes。</div>}
            </div>
          </div>
        </aside>
      </div>

      <footer className="workflow-footer">
        <div>节点: {nodes.length} | 连线: {edges.length} | localStorage 草稿</div>
        <div>Workflow v4 · 模拟模式 · 未调用 Hermes</div>
      </footer>
    </section>
  );
}

export default WorkflowPage;
