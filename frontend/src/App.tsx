import React, { useCallback, useState, useMemo } from 'react';
import ReactFlow, {
  Node,
  Edge,
  addEdge,
  Connection,
  useNodesState,
  useEdgesState,
  Background,
} from 'reactflow';
import 'reactflow/dist/style.css';

// Node types
const nodeTypes = {
  start: ({ data }: any) => (
    <div className="node-start">开始</div>
  ),
  llm: ({ data }: any) => (
    <div className="node-llm">LLM 调用: {data.label}</div>
  ),
  tool: ({ data }: any) => (
    <div className="node-tool">工具: {data.label}</div>
  ),
  end: ({ data }: any) => (
    <div className="node-end">结束</div>
  ),
};

// Initial nodes and edges
const initialNodes: Node[] = [
  {
    id: '1',
    type: 'start',
    position: { x: 100, y: 100 },
    data: { label: '开始' },
  },
];

const initialEdges: Edge[] = [];

function WorkflowPage() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  const onNodeClick = useCallback((event: any, node: Node) => {
    setSelectedNode(node);
  }, []);

  const updateNodeData = useCallback((id: string, newData: any) => {
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === id) {
          return { ...node, data: { ...node.data, ...newData } };
        }
        return node;
      })
    );
  }, [setNodes]);

  const runWorkflow = useCallback(() => {
    console.log('运行工作流:', { nodes, edges });
    alert('工作流模拟运行完成！（最小MVP）');
  }, [nodes, edges]);

  const sessionSummary = useMemo(() => {
    return nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.data.label || '未命名节点',
      summary: `节点类型: ${node.type}，位置: (${Math.round(node.position.x)}, ${Math.round(node.position.y)})`,
    }));
  }, [nodes]);

  return (
    <div className="workflow-page" style={{ height: 'calc(100vh - 140px)', display: 'flex' }}>
      {/* 左侧节点面板 */}
      <div className="node-palette" style={{ width: '180px', borderRight: '1px solid #e8e6e1', padding: '12px', background: '#f8f6f3' }}>
        <div className="section-heading"><h3>节点库</h3></div>
        <div className="node-item" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', 'start')}>开始节点</div>
        <div className="node-item" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', 'llm')}>LLM 调用</div>
        <div className="node-item" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', 'tool')}>工具调用</div>
        <div className="node-item" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', 'end')}>结束节点</div>
      </div>

      {/* 中央画布 */}
      <div className="canvas-container" style={{ flex: 1, position: 'relative' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          fitView
        >
          <Background />
        </ReactFlow>
        <button onClick={runWorkflow} style={{ position: 'absolute', bottom: '20px', right: '20px', padding: '8px 16px' }}>
          模拟运行工作流
        </button>
      </div>

      {/* 右侧属性面板 */}
      <div className="properties-panel" style={{ width: '260px', borderLeft: '1px solid #e8e6e1', padding: '12px', background: '#f8f6f3' }}>
        <div className="section-heading"><h3>属性</h3></div>
        {selectedNode ? (
          <div>
            <label>节点名称</label>
            <input
              value={selectedNode.data.label || ''}
              onChange={(e) => updateNodeData(selectedNode.id, { label: e.target.value })}
              style={{ width: '100%', padding: '8px', margin: '8px 0' }}
            />
            <label>Prompt / 配置</label>
            <textarea
              value={selectedNode.data.prompt || ''}
              onChange={(e) => updateNodeData(selectedNode.id, { prompt: e.target.value })}
              style={{ width: '100%', height: '120px', padding: '8px' }}
            />
          </div>
        ) : (
          <p>点击节点编辑属性</p>
        )}
      </div>

      {/* 底部状态栏 */}
      <div className="status-bar" style={{ position: 'absolute', bottom: '0', left: '180px', right: '260px', height: '36px', background: '#f0ede8', borderTop: '1px solid #e8e6e1', display: 'flex', alignItems: 'center', padding: '0 12px', fontSize: '12px', color: '#666' }}>
        节点数: {nodes.length} | 连线数: {edges.length} | 已保存
      </div>
    </div>
  );
}

// Add to existing App.tsx tab system (simplified for MVP)
function App() {
  const [activeTab, setActiveTab] = useState('office');

  const tabs = [
    { id: 'office', label: '办公室' },
    { id: 'workspace', label: '工作空间' },
    { id: 'agent', label: 'Agent' },
    { id: 'evolution', label: '进化档案' },
    { id: 'tasks', label: '任务动态' },
    { id: 'workflow', label: '工作流' }, // New tab
  ];

  return (
    <div className="app">
      <div className="tab-bar">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={activeTab === tab.id ? 'active' : ''}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="main-content">
        {activeTab === 'workflow' && <WorkflowPage />}
        {/* Other tabs remain as before */}
      </div>
    </div>
  );
}

export default App;
