import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface WorkflowNode {
  id: string;
  type: 'start' | 'llm' | 'tool' | 'weixin' | 'condition' | 'hermes_call' | 'end';
  x: number;
  y: number;
  label: string;
  prompt?: string;
  config?: Record<string, any>;
}

interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  fromPort?: 'output';
  toPort?: 'input';
}

const GRID_SIZE = 24;

const initialNodes: WorkflowNode[] = [
  { id: '1', type: 'start', x: 120, y: 120, label: '开始', prompt: '工作流开始' },
];

const nodeColors: Record<string, string> = {
  start: '#137333',
  llm: '#477fac',
  tool: '#9e6c00',
  weixin: '#1e88e5',
  condition: '#8e24aa',
  hermes_call: '#e64a19',
  end: '#b3261e',
};

export function WorkflowPage() {
  const [nodes, setNodes] = useState<WorkflowNode[]>(initialNodes);
  const [edges, setEdges] = useState<WorkflowEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectFromId, setConnectFromId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentRunningNode, setCurrentRunningNode] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const selectedNode = useMemo(() => nodes.find(n => n.id === selectedNodeId), [nodes, selectedNodeId]);

  const snapToGrid = useCallback((pos: number) => Math.round(pos / GRID_SIZE) * GRID_SIZE, []);

  const addNode = useCallback((type: WorkflowNode['type'], x: number, y: number) => {
    const newNode: WorkflowNode = {
      id: `${type}-${Date.now()}`,
      type,
      x: snapToGrid(x),
      y: snapToGrid(y),
      label: type === 'start' ? '开始' : 
             type === 'llm' ? 'LLM 调用' : 
             type === 'tool' ? '工具调用' : 
             type === 'weixin' ? '微信 Gateway' :
             type === 'condition' ? '条件分支' :
             type === 'hermes_call' ? 'Hermes 调用' : '结束',
      prompt: type === 'llm' || type === 'hermes_call' ? '在这里输入 Prompt 或 Skill 名称' : undefined,
      config: type === 'weixin' ? { account: 'local-hermes', action: 'send' } : undefined,
    };
    setNodes(prev => [...prev, newNode]);
    addToLog(`添加节点: ${newNode.label}`);
  }, [snapToGrid]);

  const updateNode = useCallback((id: string, updates: Partial<WorkflowNode>) => {
    setNodes(prev => prev.map(node => node.id === id ? { ...node, ...updates } : node));
  }, []);

  const deleteNode = useCallback((id: string) => {
    if (!confirm('确定删除此节点？')) return;
    setNodes(prev => prev.filter(n => n.id !== id));
    setEdges(prev => prev.filter(e => e.from !== id && e.to !== id));
    if (selectedNodeId === id) setSelectedNodeId(null);
    addToLog(`删除节点 ${id}`);
  }, [selectedNodeId]);

  const addEdge = useCallback((from: string, to: string) => {
    if (from === to) return;
    const newEdge: WorkflowEdge = {
      id: `edge-${from}-${to}-${Date.now()}`,
      from,
      to,
    };
    setEdges(prev => {
      if (prev.some(e => e.from === from && e.to === to)) return prev;
      return [...prev, newEdge];
    });
    addToLog(`创建连线: ${from} → ${to}`);
  }, []);

  const addToLog = useCallback((message: string) => {
    setLog(prev => [...prev.slice(-8), `[${new Date().toLocaleTimeString()}] ${message}`]);
  }, []);

  const runWorkflow = useCallback(async () => {
    if (isRunning) return;
    setIsRunning(true);
    setLog([]);
    addToLog('模拟运行开始：不会真正调用 Hermes');

    const sortedNodes = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);

    for (const node of sortedNodes) {
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

      await new Promise(r => setTimeout(r, 280));
    }

    setCurrentRunningNode(null);
    addToLog('模拟运行完成：当前 mode=simulated');
    setIsRunning(false);

    alert('工作流模拟运行完成\n\n当前不会调用 Hermes / outbox\n真实执行引擎会在下一版接入');
  }, [nodes, isRunning, addToLog]);

  const exportWorkflow = useCallback(() => {
    const data = { nodes, edges, version: 'v4' };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'workflow-v4.json';
    a.click();
    URL.revokeObjectURL(url);
    addToLog('📤 工作流已导出为 JSON');
  }, [nodes, edges]);

  const importWorkflow = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string);
          if (data.nodes) setNodes(data.nodes);
          if (data.edges) setEdges(data.edges);
          addToLog('📥 工作流导入成功 (v4)');
        } catch (err) {
          alert('JSON 格式错误');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

  // Mouse and drag handlers (enhanced with ports and Bezier)
  const onCanvasClick = useCallback((e: React.MouseEvent) => {
    if (!canvasRef.current || selectedNodeId) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    addNode('llm', x, y);
  }, [addNode, selectedNodeId]);

  const onNodeMouseDown = useCallback((id: string, e: React.MouseEvent, isPort = false) => {
    e.stopPropagation();
    if (isPort) {
      setIsConnecting(true);
      setConnectFromId(id);
      addToLog(`开始从 ${id} 端口拖拽连线`);
      return;
    }
    setSelectedNodeId(id);
    setDragNodeId(id);
    setIsDragging(true);
  }, []);

  const onCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging && dragNodeId && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const x = snapToGrid(e.clientX - rect.left - 50);
      const y = snapToGrid(e.clientY - rect.top - 30);
      updateNode(dragNodeId, { x: Math.max(40, x), y: Math.max(40, y) });
    }
  }, [isDragging, dragNodeId, updateNode, snapToGrid]);

  const onCanvasMouseUp = useCallback((e: React.MouseEvent) => {
    if (isConnecting && connectFromId && canvasRef.current) {
      // Simple auto-connect to nearest node (for demo; in full version would detect drop target)
      const nearest = nodes.find(n => n.id !== connectFromId);
      if (nearest) {
        addEdge(connectFromId, nearest.id);
      }
      setIsConnecting(false);
      setConnectFromId(null);
    }
    setIsDragging(false);
    setDragNodeId(null);
  }, [isConnecting, connectFromId, nodes, addEdge]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/plain') as WorkflowNode['type'];
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    addNode(type, x, y);
  }, [addNode]);

  // Keyboard delete
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' && selectedNodeId) {
        deleteNode(selectedNodeId);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNodeId, deleteNode]);

  // Auto save
  useEffect(() => {
    localStorage.setItem('workflow-nodes-v4', JSON.stringify(nodes));
    localStorage.setItem('workflow-edges-v4', JSON.stringify(edges));
  }, [nodes, edges]);

  useEffect(() => {
    const savedNodes = localStorage.getItem('workflow-nodes-v4');
    const savedEdges = localStorage.getItem('workflow-edges-v4');
    if (savedNodes) setNodes(JSON.parse(savedNodes));
    if (savedEdges) setEdges(JSON.parse(savedEdges));
  }, []);

  return (
    <div className="workflow-studio" style={{ height: 'calc(100vh - 140px)', display: 'flex', flexDirection: 'column', background: '#f8f6f3' }}>
      <div className="toolbar" style={{ padding: '10px 16px', background: '#f0ede8', borderBottom: '1px solid #e8e6e1', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={runWorkflow} disabled={isRunning} style={{ padding: '9px 22px', background: isRunning ? '#999' : '#477fac', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 700, cursor: isRunning ? 'not-allowed' : 'pointer' }}>
          {isRunning ? '模拟中...' : '模拟运行'}
        </button>
        <button onClick={exportWorkflow} style={{ padding: '9px 16px', background: '#e8e6e1', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 500 }}>导出 JSON</button>
        <button onClick={importWorkflow} style={{ padding: '9px 16px', background: '#e8e6e1', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 500 }}>导入 JSON</button>
        <button onClick={() => { setNodes(initialNodes); setEdges([]); setLog([]); localStorage.removeItem('workflow-nodes-v4'); localStorage.removeItem('workflow-edges-v4'); }} style={{ padding: '9px 16px', background: '#fce8e6', color: '#b3261e', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>清空画布</button>

        <div style={{ flex: '1 1 120px', minWidth: '112px', textAlign: 'center', fontSize: '11px', color: '#8a6d3b', fontWeight: 650, background: '#fff8e8', border: '1px solid #edd9a8', borderRadius: '999px', padding: '4px 8px' }}>模拟模式 · 未调用 Hermes</div>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
        {/* 左侧节点库 */}
        <div style={{ width: '190px', background: '#f8f6f3', borderRight: '1px solid #e8e6e1', padding: '16px', overflowY: 'auto' }}>
          <div style={{ fontWeight: 700, marginBottom: '16px', color: '#222', fontSize: '15px' }}>节点库 (v4)</div>
          {(['start', 'llm', 'tool', 'weixin', 'condition', 'hermes_call', 'end'] as const).map(type => (
            <div
              key={type}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/plain', type)}
              style={{
                padding: '14px 12px',
                marginBottom: '10px',
                background: '#ffffff',
                border: `2px solid ${nodeColors[type]}`,
                borderRadius: '10px',
                cursor: 'grab',
                textAlign: 'center',
                fontSize: '14px',
                fontWeight: 600,
                boxShadow: '0 2px 6px rgba(0,0,0,0.06)',
                color: nodeColors[type],
              }}
            >
              {type === 'start' ? '开始' : 
               type === 'llm' ? 'LLM' : 
               type === 'tool' ? '工具' : 
               type === 'weixin' ? '📱 微信 Gateway' :
               type === 'condition' ? '🔀 条件' :
               type === 'hermes_call' ? '🔗 Hermes 调用' : '结束'}
            </div>
          ))}
        </div>

        {/* 中央画布 */}
        <div
          ref={canvasRef}
          onClick={onCanvasClick}
          onMouseMove={onCanvasMouseMove}
          onMouseUp={onCanvasMouseUp}
          onMouseLeave={onCanvasMouseUp}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          style={{
            flex: 1,
            position: 'relative',
            background: '#faf8f5',
            backgroundImage: `linear-gradient(#e8e6e1 1px, transparent 1px), linear-gradient(90deg, #e8e6e1 1px, transparent 1px)`,
            backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px`,
            overflow: 'hidden',
            cursor: 'crosshair',
            userSelect: 'none',
          }}
        >
          {/* Nodes with ports */}
          {nodes.map(node => {
            const isSelected = selectedNodeId === node.id;
            const isRunningNode = currentRunningNode === node.id;
            return (
              <div
                key={node.id}
                onMouseDown={(e) => onNodeMouseDown(node.id, e)}
                style={{
                  position: 'absolute',
                  left: node.x,
                  top: node.y,
                  padding: '16px 20px',
                  background: '#ffffff',
                  border: isSelected ? `3px solid ${nodeColors[node.type]}` : `2px solid ${nodeColors[node.type]}`,
                  borderRadius: '12px',
                  boxShadow: isRunningNode ? '0 0 0 4px rgba(71, 127, 172, 0.3)' : '0 6px 16px rgba(0,0,0,0.1)',
                  cursor: 'grab',
                  minWidth: '148px',
                  textAlign: 'center',
                  fontWeight: 700,
                  fontSize: '14.5px',
                  transition: 'all 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
                  zIndex: isSelected || isRunningNode ? 30 : 20,
                }}
              >
                <div style={{ color: nodeColors[node.type], marginBottom: '6px', fontSize: '18px' }}>
                  {node.type === 'weixin' ? '📱' : node.type === 'hermes_call' ? '🔗' : node.type === 'condition' ? '🔀' : '◉'}
                </div>
                {node.label}
                
                {/* Output Port (right) */}
                <div
                  onMouseDown={(e) => onNodeMouseDown(node.id, e, true)}
                  style={{
                    position: 'absolute',
                    right: '-8px',
                    top: '50%',
                    width: '18px',
                    height: '18px',
                    background: '#fff',
                    border: `3px solid ${nodeColors[node.type]}`,
                    borderRadius: '50%',
                    cursor: 'crosshair',
                    transform: 'translateY(-50%)',
                    zIndex: 40,
                  }}
                />
                
                {/* Input Port (left) */}
                <div
                  style={{
                    position: 'absolute',
                    left: '-8px',
                    top: '50%',
                    width: '18px',
                    height: '18px',
                    background: '#fff',
                    border: `3px solid ${nodeColors[node.type]}`,
                    borderRadius: '50%',
                    transform: 'translateY(-50%)',
                    zIndex: 40,
                  }}
                />
                
                {isSelected && (
                  <div 
                    onClick={(e) => { e.stopPropagation(); deleteNode(node.id); }}
                    style={{ 
                      position: 'absolute', 
                      top: '-10px', 
                      right: '-10px', 
                      background: '#b3261e', 
                      color: 'white', 
                      borderRadius: '50%', 
                      width: '22px', 
                      height: '22px', 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'center', 
                      fontSize: '15px', 
                      cursor: 'pointer',
                      boxShadow: '0 3px 8px rgba(179,38,30,0.4)'
                    }}
                  >×</div>
                )}
              </div>
            );
          })}

          {/* Edges - Bezier curves */}
          <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 10 }} strokeLinecap="round">
            {edges.map(edge => {
              const fromNode = nodes.find(n => n.id === edge.from);
              const toNode = nodes.find(n => n.id === edge.to);
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
                    stroke="#8b9bad" 
                    strokeWidth="3.5" 
                    fill="none" 
                    strokeDasharray="6 2"
                  />
                  <circle cx={x2} cy={y2} r="5" fill="#477fac" />
                </g>
              );
            })}
          </svg>

          <div style={{ position: 'absolute', bottom: '20px', left: '24px', fontSize: '12.5px', color: '#666', background: 'rgba(248,246,243,0.9)', padding: '6px 14px', borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
            拖拽左侧节点到画布 • 从右侧端口拖拽连线 • 网格吸附已启用 • Delete 删除选中节点 • v4 优化完成
          </div>
        </div>

        {/* 右侧属性面板 */}
        <div style={{ width: '290px', background: '#f8f6f3', borderLeft: '1px solid #e8e6e1', padding: '20px', overflowY: 'auto', boxShadow: '-4px 0 14px rgba(0,0,0,0.06)' }}>
          <div style={{ fontWeight: 700, marginBottom: '20px', color: '#222', fontSize: '16px' }}>节点属性 (v4)</div>
          {selectedNode ? (
            <div style={{ display: 'grid', gap: '18px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '13px', color: '#555', fontWeight: 600 }}>节点名称</label>
                <input
                  value={selectedNode.label}
                  onChange={(e) => updateNode(selectedNode.id, { label: e.target.value })}
                  style={{ width: '100%', padding: '11px 14px', border: '1px solid #d4d2cc', borderRadius: '9px', fontSize: '14.5px' }}
                />
              </div>
              {(selectedNode.type === 'llm' || selectedNode.type === 'hermes_call') && (
                <div>
                  <label style={{ display: 'block', marginBottom: '8px', fontSize: '13px', color: '#555', fontWeight: 600 }}>Prompt / Skill</label>
                  <textarea
                    value={selectedNode.prompt || ''}
                    onChange={(e) => updateNode(selectedNode.id, { prompt: e.target.value })}
                    style={{ width: '100%', height: '138px', padding: '12px', border: '1px solid #d4d2cc', borderRadius: '9px', fontSize: '13.5px', resize: 'vertical', lineHeight: 1.5 }}
                    placeholder="输入 Prompt 或 Hermes Skill 名称..."
                  />
                </div>
              )}
              {selectedNode.type === 'weixin' && (
                <div style={{ background: '#e3f2fd', padding: '14px', borderRadius: '10px', fontSize: '13px' }}>
                  已连接本地 Hermes Weixin Gateway<br/>当前账号: local-hermes
                </div>
              )}
              <button onClick={() => deleteNode(selectedNode.id)} style={{ padding: '12px', background: '#b3261e', color: 'white', border: 'none', borderRadius: '9px', fontWeight: 700, cursor: 'pointer' }}>
                删除此节点
              </button>
            </div>
          ) : (
            <div style={{ color: '#777', textAlign: 'center', padding: '80px 20px', lineHeight: 1.6, fontSize: '14px' }}>
              点击任意节点<br/>编辑属性与配置
            </div>
          )}

          {/* 执行日志面板 */}
          <div style={{ marginTop: '32px' }}>
            <div style={{ fontWeight: 700, marginBottom: '10px', color: '#222', fontSize: '15px', display: 'flex', justifyContent: 'space-between' }}>
              <span>执行日志</span>
              <span style={{ fontSize: '11px', color: '#888', fontWeight: 400 }}>v4 实时</span>
            </div>
            <div style={{ 
              background: '#2c2c2c', 
              color: '#a5d6a7', 
              padding: '14px', 
              borderRadius: '10px', 
              height: '210px', 
              overflowY: 'auto', 
              fontFamily: 'monospace', 
              fontSize: '12.2px', 
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap'
            }}>
              {log.length > 0 ? log.join('\n') : '点击「模拟运行」开始本地模拟，不会调用 Hermes...'}
            </div>
          </div>
        </div>
      </div>

      <div style={{ minHeight: '46px', background: '#f0ede8', borderTop: '1px solid #e8e6e1', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', fontSize: '11px', color: '#137333', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>节点: {nodes.length} | 连线: {edges.length} | localStorage 草稿</div>
        <div style={{ fontWeight: 600, minWidth: 0 }}>Workflow v4 · 模拟模式 · 未调用 Hermes</div>
      </div>
    </div>
  );
}

