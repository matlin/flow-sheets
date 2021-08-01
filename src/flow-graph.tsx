import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  DragEventHandler,
  useMemo,
} from "react";
import XLSX from "xlsx";

import ReactFlow, {
  updateEdge,
  getConnectedEdges,
  Controls,
  Background,
  isEdge,
  Elements,
  FlowElement,
  OnEdgeUpdateFunc,
  Connection,
  Node,
  Edge,
  BackgroundVariant,
  PanOnScrollMode,
  XYPosition,
  OnLoadFunc,
  OnLoadParams,
  isNode,
} from "react-flow-renderer";
import * as AllNodes from "./graph-nodes/index";

import * as Y from "yjs";

import { ItemPredicate, ItemRenderer, Omnibar } from "@blueprintjs/select";
import {
  HotkeysTarget2,
  MenuItem,
  ContextMenu,
  Menu,
  Icon,
  Drawer,
  DrawerSize,
  Classes,
  Collapse,
  Card,
} from "@blueprintjs/core";

import { OmnibarItem } from "./types";
import Graph from "./graph";
import { jsonToTable, matrixToTable } from "./utils/tables";
import { csvToJson } from "./utils/files";
import { isWritableElement } from "./utils/elements";
import {
  addElementsToClipboard,
  ClipboardParseResult,
  ElementClipboardContext,
  parseClipboard,
} from "./utils/clipboard";
import { combineLatest } from "rxjs";
import ProGraph, { GraphEdge, GraphNode } from "./prograph";
import { map } from "rxjs/operators";
import Spreadsheet from "./components/blueprint-spreadsheet";
import { Table } from "./types";

import DefaultEdge from "./graph-nodes/edges/default-edge";
import { create, Struct } from "superstruct";
import toaster from "./components/app-toaster";
import NewSheetDialog from "./components/new-sheet-dialog";
import graphManager from "./graph-manager";
import SelectGraphDialog from "./components/select-graph-dialog";
import { useHistory, useParams } from "react-router-dom";
import MouseNode from "./graph-nodes/utils/mouse-node";

const onElementClick = (event: React.MouseEvent, element: Node | Edge) => {};

const initBgColor = "#343434";

const connectionLineStyle = { stroke: "#fff" };
const snapGrid: [number, number] = [20, 20];

function flattenNodes(nodes: Record<string, any>): [string, any][] {
  return Object.entries(nodes).flatMap(([key, val]) =>
    val.Component ? [[key, val]] : flattenNodes(val),
  );
}

const GraphNodes = Object.fromEntries(flattenNodes(AllNodes));

const nodeTypes = Object.fromEntries(
  Object.entries(GraphNodes).map(([key, val]) => {
    const { Component } = val;
    // add additional custom props to node types
    // RF only passes specific documented element props to component func
    const componentWrapper = ({ ...props }) => {
      // TODO: hot reload issue
      const node = proGraph.getNode(props.id);
      return Component({
        ...props,
        size: node.size,
      });
    };
    return [key, componentWrapper];
  }),
);

nodeTypes.mouse = MouseNode;

const defaultOmnibarOptions = Object.keys(nodeTypes).map((t) => ({
  type: t,
  label: t,
  data: {},
}));

const ElementInfoMenuItem = ({ element }: { element: FlowElement }) => {
  const [isOpen, setIsOpen] = useState(false);
  const error = element.data?.inputs?.error || element.data?.outputs?.error;
  return (
    <>
      <div onClick={() => setIsOpen((wasOpen) => !wasOpen)}>
        <b>
          <Icon icon={isOpen ? "caret-down" : "caret-right"} /> {element.id}
        </b>
      </div>
      <Collapse isOpen={isOpen}>
        <Card>
          <div>
            <b>Type:</b> {element.type}
          </div>
          {error ? (
            <div>
              <b>Error:</b> {error.message}
            </div>
          ) : (
            ""
          )}
        </Card>
      </Collapse>
    </>
  );
};

function getComponentDataForNode(node) {
  const nodeClass = GraphNodes[node.type];
  const inputEntries: [string, Struct][] = nodeClass.inputs
    ? Object.entries(nodeClass.inputs)
    : [];
  const sourceEntries: [string, Struct][] = nodeClass.sources
    ? Object.entries(nodeClass.sources)
    : [];
  const outputKeys = nodeClass.outputs ? Object.keys(nodeClass.outputs) : [];

  const inputVals = proGraph.getNodeInputs(node.id);
  const inputs = Object.fromEntries(
    inputEntries.map(([key, struct]) => [
      key,
      create(inputVals[key].value, struct),
    ]),
  );
  const sources = sourceEntries.reduce((acc, curr) => {
    const [key, struct] = curr;
    acc[key] = {
      value: create(node.sources[key], struct),
      set: (newVal) => {
        proGraph.updateNodeSources(node.id, { [key]: newVal });
      },
    };
    return acc;
  }, {});
  const outputs = outputKeys.reduce((acc, curr) => {
    acc[curr] = node.outputs && node.outputs[curr].value;
    return acc;
  }, {});

  return {
    inputs,
    sources,
    outputs,
  };
}

function graphToReactFlow(
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): Elements {
  const flowNodes: Node[] = Array.from(nodes.values()).map((node) => ({
    position: node.position,
    // TODO pass in Graph Values
    data: getComponentDataForNode(node),
    type: node.type,
    id: node.id.toString(),
    style: {
      padding: "10px",
      border: "1px solid white",
      borderRadius: "10px",
    },
  }));

  const flowEdges: Edge[] = Array.from(edges.values()).map((conn) => {
    const fromNode = proGraph.getNode(conn.from.nodeId);
    const toNodeInputs = proGraph.getNodeInputs(conn.to.nodeId);
    return {
      id: conn.id.toString(),
      source: conn.from.nodeId.toString(),
      sourceHandle: conn.from.busKey,
      target: conn.to.nodeId.toString(),
      targetHandle: conn.to.busKey,
      data: {
        outputs: fromNode.outputs ? fromNode.outputs[conn.from.busKey] : {},
        inputs: toNodeInputs ? toNodeInputs[conn.to.busKey] : {},
      },
    };
  });
  return [...flowNodes, ...flowEdges];
}

const proGraph = new ProGraph(GraphNodes);

// Use sparingly, main use case is to add unsupported interactions to nodes (ie resizing)
// May also be a good way to access react flow instance in the future if nodes need to be aware of graph state (ie zoom level)
export const GraphInternals = React.createContext<{
  proGraph: ProGraph;
  reactFlowInstance: OnLoadParams;
}>({
  proGraph: proGraph,
  reactFlowInstance: undefined,
});

console.log(proGraph, graphManager);
if (process.env.NODE_ENV === "development") {
  // @ts-ignore
  window.Y = Y;
  // @ts-ignore
  window.prograph = proGraph;
}

interface SpreadSheetTableData {
  initialData: Table;
  nodeId: string;
}

const edgeTypes = {
  default: DefaultEdge,
};

const FlowGraph = () => {
  const [reactflowInstance, setReactflowInstance] =
    useState<OnLoadParams | null>(null);

  const [graphElements, setGraphElements] = useState<Elements>([]);
  const [mouseElements, setMouseElements] = useState<Elements>([]);
  const [suggestedEdges, setSuggestedEdges] = useState<Elements>([]);

  const [bgColor, setBgColor] = useState(initBgColor);
  const [sideMenuOpen, setSideMenuOpen] = useState(false);
  const [bottomMenuOpen, setBottomMenuOpen] = useState(false);
  const [selectedElements, setSelectedElements] = useState<Elements>([]);
  const [omnibarQuery, setOmnibarQuery] = useState("");
  const [nodeTypeList, setNodeTypeList] = useState<OmnibarItem[]>(
    defaultOmnibarOptions,
  );

  const [newGraphLoaded, setNewGraphLoaded] = useState(false);

  const [showNewDialog, setShowNewDialog] = useState(false);
  const [showSelectDialog, setShowSelectDialog] = useState(false);

  const { graphPath } = useParams<{ graphPath?: string }>();
  const history = useHistory();

  const graphId: string | null = useMemo(
    () => (graphPath ? graphPath.slice(-21) : null),
    [graphPath],
  );

  const graphName: string | null = useMemo(
    () =>
      graphPath ? graphPath.slice(0, -21).split("-").join(" ").trim() : null,
    [graphPath],
  );

  useEffect(() => {
    if (!newGraphLoaded || graphElements.length === 0 || !reactflowInstance)
      return;

    // zoom to previous state if available
    const canvasPosition = localStorage.getItem(`flowgraph-state-${graphId}`);
    if (canvasPosition) {
      reactflowInstance.setTransform(JSON.parse(canvasPosition));
    } else {
      reactflowInstance.fitView();
    }

    setNewGraphLoaded(false);
  }, [newGraphLoaded, graphElements, reactflowInstance]);

  useEffect(() => {
    setShowNewDialog(false);
    setShowSelectDialog(false);

    const loadedGraphSub = proGraph.loadedGraph$.subscribe(() => {
      setNewGraphLoaded(true);
    });

    if (!graphPath) {
      /**
       * This can likely all be derived from the
       * `lastAccessed` field in the GraphManager
       */
      const savedLastGraph = window.localStorage.getItem("lastGraph");
      if (savedLastGraph) {
        history.push(`/${savedLastGraph}`);
      } else {
        graphManager.createGraph().then((newGraphId) => {
          history.push(`/${newGraphId}`);
        });
      }
    } else {
      window.localStorage.setItem("lastGraph", graphId);
      graphManager.selectGraph(graphId, graphName);
      proGraph.loadGraph(graphId);

      const flowElements$ = combineLatest(
        proGraph.nodes$,
        proGraph.edges$,
      ).pipe(map(([nodes, edges]) => graphToReactFlow(nodes, edges)));

      const elementSubscription = flowElements$.subscribe((els) => {
        setGraphElements(els);
      });

      toaster.show({
        intent: "success",
        message: `You are now viewing Graph ID:${graphId}`,
      });

      proGraph.presence.setLocalState({
        name: "Anonymous",
        mousePosition: { x: 0, y: 0 },
      });
      proGraph.presence.on("change", () => {
        const collaboratorStates = Array.from(
          proGraph.presence.getStates().entries(),
        ).filter(([key]) => key !== proGraph.presence.clientID);
        const mouseElems: Elements = collaboratorStates.map(([key, state]) => ({
          position: state.mousePosition,
          id: `${key}-mouse`,
          type: "mouse",
          data: { label: state.name },
        }));
        setMouseElements(mouseElems);
      });

      return () => {
        elementSubscription.unsubscribe();
        loadedGraphSub.unsubscribe();
      };
    }
  }, [graphPath]);

  const [spreadsheetTableData, setSpreadsheetTableData] =
    useState<SpreadSheetTableData>();

  useEffect(() => {
    if (omnibarQuery) {
      const validNumber = !isNaN(Number(omnibarQuery));
      setNodeTypeList([
        ...(validNumber
          ? [
              {
                type: "Number",
                label: `Number: ${omnibarQuery}`,
                data: { number: Number(omnibarQuery) },
              },
            ]
          : []),
        ...defaultOmnibarOptions,
        {
          type: "Text",
          label: `Text: ${omnibarQuery}`,
          data: { text: omnibarQuery },
        },
      ]);
    } else {
      setNodeTypeList([...defaultOmnibarOptions]);
    }
  }, [omnibarQuery]);

  // TODO remove in favor of prograph
  const graphRef = useRef<Graph>();

  const validateConnection = (
    connection: Connection | Edge<any>,
    els: Elements,
  ) => {
    /**
     * There are hooks on initial connection to a handle to check if the connection is valid
     * - https://reactflow.dev/docs/api/handle/
     * Unfortunately, this is not available on an edge update
     * - https://github.com/wbkd/react-flow/issues/1034
     *
     * Manually enforcing that on connections/updates that no other incoming edges exist for that handle
     * That may not always be the case, but for now that seems correct
     */

    const target = els.find(({ id }) => id === connection.target) as Node<any>;
    if (!target) return false;
    const edges = els.filter((el) => isEdge(el)) as Edge<any>[];
    const handleEdges = getConnectedEdges([target], edges).filter(
      (edge) =>
        edge.target === target.id &&
        edge.targetHandle === connection.targetHandle,
    );

    if (
      handleEdges.length >= 1 &&
      handleEdges.some((edge) => !edge.data.isSuggested)
    ) {
      console.log("INVALID: ALREADY AN EDGE ON THIS HANDLE");
      return false;
    }

    return true;
  };

  const getEdgeStreams = (edge: Connection | Edge<any>, els: Elements) => {
    const sourceNode = els.find(({ id }) => id === edge.source);
    const targetNode = els.find(({ id }) => id === edge.target);
    const sourceOutput = sourceNode!.data.sinks[edge.sourceHandle!];
    const targetInput = targetNode!.data.sources[edge.targetHandle!];

    return [sourceOutput, targetInput];
  };

  const onEdgeConnect = (edge: Connection | Edge<any>, els: Elements) => {
    const [sourceOutput, targetInput] = getEdgeStreams(edge, els);
    sourceOutput.subscribe((latestVal: any) => {
      targetInput.next(latestVal);
    });
  };

  const onEdgeDisconnect = (edge: Connection | Edge<any>, els: Elements) => {
    const [sourceOutput, targetInput] = getEdgeStreams(edge, els);
    // TODO fix for RXJS
  };

  const onConnect = (connection: Connection | Edge<any>) => {
    proGraph.addEdge({
      from: {
        nodeId: connection.source,
        busKey: connection.sourceHandle,
      },
      to: {
        nodeId: connection.target,
        busKey: connection.targetHandle,
      },
    });
  };

  const onElementsRemove = (elementsToRemove: Elements) => {
    for (const el of elementsToRemove) {
      if (isEdge(el)) {
        proGraph.deleteEdge(el.id);
      } else {
        proGraph.deleteNode(el.id);
        if (spreadsheetTableData?.nodeId === el.id)
          setSpreadsheetTableData(undefined);
      }
    }
  };

  const onEdgeUpdate: OnEdgeUpdateFunc<any> = (oldEdge, newConnection) => {
    setGraphElements((els) => {
      if (!validateConnection(newConnection, els)) return els;
      onEdgeDisconnect(oldEdge, els);
      onEdgeConnect(newConnection, els);
      return updateEdge(oldEdge, newConnection, els);
    });
  };

  const addNode = useCallback(({ type, data, position }) => {
    // @ts-ignore
    const { outputs, sources } = GraphNodes[type];
    const values =
      data ||
      Object.fromEntries(
        [
          ...(outputs ? Object.keys(outputs) : []),
          ...(sources ? Object.keys(sources) : []),
        ].map((key) => [
          key,
          null, // TODO use default value from Node definition
        ]),
      );
    proGraph.addNode({ type, position, sources: values });
  }, []);

  const onLoad: OnLoadFunc<any> = useCallback(
    (rfi) => {
      if (!reactflowInstance) {
        setReactflowInstance(rfi);
      }
    },
    [reactflowInstance],
  );

  function parseFileData(file: File, callback: (data: any) => void) {
    const reader = new FileReader();
    reader.onload = function (e) {
      const data = new Uint8Array(e.target!.result as ArrayBuffer);
      const workbook = XLSX.read(data, { type: "array" });
      const json_data = XLSX.utils.sheet_to_json(
        workbook.Sheets[Object.keys(workbook.Sheets)[0]], // todo: Possibly load all "Sheets" as separate data sources?
        { raw: false },
      );
      callback(json_data);
    };
    reader.readAsArrayBuffer(file);
  }

  async function addFileNode(
    entry: FileSystemFileHandle,
    label: string,
    position: XYPosition,
  ) {
    const file = await entry.getFile();
    const jsonData = await csvToJson(file);
    const tableData = jsonToTable(jsonData);
    addNode({
      type: "DataTable",
      data: {
        table: tableData,
        label: file.name,
      },
      position,
    });
  }

  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  const onDragOver: DragEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    event.dataTransfer!.dropEffect = "move";
  };

  const onDrop: React.DragEventHandler<HTMLDivElement> = async (event) => {
    event.preventDefault();
    if (reactFlowWrapper.current == null || reactflowInstance == null) return;
    const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
    // const type = event.dataTransfer.getData("application/reactflow");
    const position = reactflowInstance.project({
      x: event.clientX - reactFlowBounds.left,
      y: event.clientY - reactFlowBounds.top,
    });

    //@ts-ignore
    for (const item of event.dataTransfer.items) {
      if (item.kind === "file") {
        const entry = await item.getAsFileSystemHandle();
        if (entry.kind === "file") {
          // TODO: maybe add position offset if multiple
          await addFileNode(entry, entry.name, position);
        } else if (entry.kind === "directory") {
          // run code for is entry is a directory
        }
      }
    }

    // const file = event.dataTransfer.files[0];
    // parseFileData(file, (json_data) => {
    //   addDataNode(json_data, file.name, position);
    // });
  };

  const getCanvasPosition = useCallback(
    (position: XYPosition) => {
      if (reactFlowWrapper.current == null || reactflowInstance == null)
        return { x: 0, y: 0 };

      const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
      return reactflowInstance.project({
        x: position.x - reactFlowBounds.left,
        y: position.y - reactFlowBounds.top,
      });
    },
    [reactflowInstance],
  );

  // Add listeners for copy and pasting into graph
  const copyElements = async (els: Elements<any>) => {
    const serializedNodes = els
      .filter((el) => isNode(el))
      .map((el) => proGraph._nodes.get(el.id));
    const serializedEdges = els
      .filter((el) => isEdge(el))
      .map((el) => proGraph._edges.get(el.id));
    // @ts-ignore
    await addElementsToClipboard(serializedNodes, serializedEdges);
  };

  useEffect(() => {
    const copyHandler = async (event: ClipboardEvent) => {
      const isWritable = isWritableElement(event.target);
      // default prevented as proxy for spreadsheet cell copies
      if (!isWritable && !event.defaultPrevented) {
        event.preventDefault();
        await copyElements(selectedElements);
      }
    };
    document.body.addEventListener("copy", copyHandler);
    return () => {
      document.body.removeEventListener("copy", copyHandler);
    };
  }, [selectedElements]);

  useEffect(() => {
    if (selectedElements.length !== 1) {
      setSuggestedEdges([]);
      return;
    }

    const [{ id }] = selectedElements;

    const suggestedConnections = proGraph
      .getSuggestedEdges()
      .filter(({ from, to }) => {
        return from.nodeId === id || to.nodeId === id;
      })
      .map((conn) => ({
        id: JSON.stringify(conn),
        source: conn.from.nodeId,
        sourceHandle: conn.from.busKey,
        target: conn.to.nodeId,
        targetHandle: conn.to.busKey,
        style: {
          stroke: "orange",
        },
        data: {
          isSuggested: true,
        },
      }));

    setSuggestedEdges(suggestedConnections);
  }, [selectedElements]);

  const mousePosition = useRef({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  });
  useEffect(() => {
    const mouseMoveHandler = (event: MouseEvent) => {
      mousePosition.current = { x: event.clientX, y: event.clientY };
    };
    document.body.addEventListener("mousemove", mouseMoveHandler);

    return () => {
      document.body.removeEventListener("mousemove", mouseMoveHandler);
    };
  }, []);

  const pasteData = async (
    clipboardResult: ClipboardParseResult,
    position: XYPosition,
  ) => {
    const { type, data } = clipboardResult;
    if (type === "text") {
      addNode({
        type: "Constant",
        data: {
          value: data,
        },
        position,
      });
    }

    if (type === "table") {
      const tableData = jsonToTable(data);
      addNode({
        type: "DataTable",
        data: {
          table: tableData,
        },
        position,
      });
    }

    // TODO: less logic in flowgraph
    if (type === "nodes") {
      const clipboardElements = data as ElementClipboardContext[];
      // TODO: better typing here
      const clipboardNodes = clipboardElements.filter(
        (clipboardElement) => clipboardElement.element.position,
      );
      const clipboardEdges = clipboardElements.filter(
        (clipboardElement) => !clipboardElement.element.position,
      );

      const newNodes = clipboardNodes.map((clipboardNode) => {
        console.log(clipboardNode);
        return proGraph.addNode({
          ...clipboardNode.element,
          position: {
            x: position.x + clipboardNode.xOffset,
            y: position.y + clipboardNode.yOffset,
          },
        });
      });

      const newNodesMap = new Map(
        newNodes.map((newNodeId, i) => [
          clipboardNodes[i].element.id,
          newNodeId,
        ]),
      );

      for (const edge of clipboardEdges) {
        if (
          newNodesMap.get(edge.element.to.nodeId) &&
          newNodesMap.get(edge.element.from.nodeId)
        ) {
          proGraph.addEdge({
            from: {
              nodeId: newNodesMap.get(edge.element.from.nodeId),
              busKey: edge.element.from.busKey,
            },
            to: {
              nodeId: newNodesMap.get(edge.element.to.nodeId),
              busKey: edge.element.to.busKey,
            },
          });
        }
      }
    }
  };

  useEffect(() => {
    const pasteHandler = async (event: ClipboardEvent) => {
      const isWritable = isWritableElement(event.target);
      // default prevented as proxy for spreadsheet cell pastes
      if (event.clipboardData && !isWritable && !event.defaultPrevented) {
        event.preventDefault();
        pasteData(
          await parseClipboard(event),
          getCanvasPosition(mousePosition.current),
        );
      }
    };
    document.body.addEventListener("paste", pasteHandler);
    return () => {
      document.body.removeEventListener("paste", pasteHandler);
    };
  }, [getCanvasPosition]);

  // Prevent document pinch zoom from firing (would happen on nowheel nodes), causes full page to zoom
  useEffect(() => {
    const wheelHandler = function (e) {
      // Ctrl key true if pinch zooming
      if (e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("wheel", wheelHandler, { passive: false });
    return () => {
      document.body.removeEventListener("wheel", wheelHandler);
    };
  }, []);

  const NodeOmnibar = Omnibar.ofType<OmnibarItem>();

  const [showNodeOmniBar, setShowNodeOmniBar] = useState(false);

  const renderNodeType: ItemRenderer<OmnibarItem> = (
    item,
    { handleClick, modifiers, query },
  ) => {
    if (!modifiers.matchesPredicate) {
      return null;
    }
    return (
      <MenuItem
        active={modifiers.active}
        disabled={modifiers.disabled}
        label={item.label}
        key={item.label}
        onClick={handleClick}
        text={item.label}
      />
    );
  };

  const filterNodeTypes: ItemPredicate<OmnibarItem> = (
    query,
    item,
    _index,
    exactMatch,
  ) => {
    const normalizedTitle = item.label.toLowerCase();
    const normalizedQuery = query.toLowerCase();
    if (!query || query.length === 0) return true;
    if (exactMatch) {
      return normalizedTitle === normalizedQuery;
    } else {
      return normalizedTitle.indexOf(normalizedQuery) >= 0;
    }
  };

  const elements = useMemo(
    () => graphElements.concat(mouseElements).concat(suggestedEdges),
    [graphElements, mouseElements, suggestedEdges],
  );

  const handleDragStart = useCallback(
    (event) => {
      if (event.altKey) {
        // Using selected elements because multiselect is tied to onNode events
        const selectedNodes = selectedElements.filter((el) => isNode(el));
        const selectedEdges = selectedElements.filter((el) => isEdge(el));
        proGraph.replaceElementGroup(
          selectedNodes.map((el) => el.id),
          selectedEdges.map((el) => el.id),
        );
      }
    },
    [selectedElements],
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        position: "relative",
        flex: 1,
        height: "100vh",
      }}
    >
      <NewSheetDialog
        isOpen={showNewDialog}
        onCancel={() => setShowNewDialog(false)}
        onSubmit={async (name: string) => {
          const graphId = await graphManager.createGraph(name);
          history.push(`/${name.split(" ").join("-")}-${graphId}`);
          setShowNewDialog(false);
        }}
      />
      <SelectGraphDialog
        isOpen={showSelectDialog}
        onClose={() => {
          setShowSelectDialog(false);
        }}
        onNew={() => {
          setShowSelectDialog(false);
          setShowNewDialog(true);
        }}
      />
      <div ref={reactFlowWrapper} style={{ flexGrow: 1 }}>
        {graphElements && ( // Don't load react flow until elements are ready
          <GraphInternals.Provider
            value={{ proGraph, reactFlowInstance: reactflowInstance }}
          >
            <ReactFlow
              elements={elements}
              panOnScroll={true}
              panOnScrollMode={PanOnScrollMode.Free}
              onMouseMove={(e) => {
                if (!reactflowInstance) return;
                const absolutePos = { x: e.clientX, y: e.clientY };
                const coordinates = reactflowInstance.project(absolutePos);
                proGraph.presence.setLocalStateField(
                  "mousePosition",
                  coordinates,
                );
              }}
              onElementClick={onElementClick}
              onElementsRemove={onElementsRemove}
              onConnect={onConnect}
              style={{ background: bgColor }}
              onDoubleClick={() => {
                console.log("double clicked...");
              }}
              onLoad={onLoad}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              connectionLineStyle={connectionLineStyle}
              snapToGrid={true}
              snapGrid={snapGrid}
              defaultZoom={1}
              onDrop={onDrop}
              onNodeDragStart={(event, _node) => handleDragStart(event)}
              onNodeDoubleClick={(e, node) => {
                if (node.type === "DataTable") {
                  const nodeId = node.id;
                  const graphNode = proGraph._nodes.get(nodeId);
                  setSpreadsheetTableData({
                    nodeId,
                    initialData: graphNode.sources.table as Table,
                  });
                  setBottomMenuOpen(true);
                } else {
                  setSpreadsheetTableData(undefined);
                }
              }}
              onSelectionDragStart={(event, _nodes) => handleDragStart(event)}
              onDragOver={onDragOver}
              onEdgeUpdate={onEdgeUpdate}
              onSelectionChange={(elements) => {
                setSelectedElements(elements || []);
              }}
              onNodeContextMenu={(event, node) => {
                // @ts-ignore
                if (event.target.closest(".base-node-content")) return;

                event.preventDefault();
                const menu = (
                  <Menu>
                    <MenuItem
                      onClick={async () => await copyElements([node])}
                      text="Copy node"
                    />
                    <MenuItem
                      onClick={() => onElementsRemove([node])}
                      text="Delete node"
                    />
                  </Menu>
                );
                ContextMenu.show(menu, {
                  left: event.clientX,
                  top: event.clientY,
                });
              }}
              onEdgeContextMenu={(event, edge) => {
                event.preventDefault();

                if (edge.data.isSuggested) {
                  onConnect(edge);
                  return;
                }

                const menu = (
                  <Menu>
                    <MenuItem
                      onClick={() => onElementsRemove([edge])}
                      text="Delete edge"
                    />
                  </Menu>
                );
                ContextMenu.show(menu, {
                  left: event.clientX,
                  top: event.clientY,
                });
              }}
              onSelectionContextMenu={(event, nodes) => {
                event.preventDefault();
                const menu = (
                  <Menu>
                    <MenuItem
                      onClick={async () => await copyElements(nodes)}
                      text="Copy nodes"
                    />
                    <MenuItem
                      onClick={() => onElementsRemove(nodes)}
                      text="Delete nodes"
                    />
                  </Menu>
                );
                ContextMenu.show(menu, {
                  left: event.clientX,
                  top: event.clientY,
                });
              }}
              onPaneContextMenu={(event) => {
                event.preventDefault();
                const menu = (
                  <Menu>
                    <MenuItem
                      onClick={() => reactflowInstance?.fitView()}
                      text="Zoom to fit"
                    />
                    <MenuItem
                      onClick={async (e: React.MouseEvent) =>
                        pasteData(
                          await parseClipboard(null),
                          getCanvasPosition({
                            x: event.clientX,
                            y: event.clientY,
                          }),
                        )
                      }
                      text="Paste"
                    />
                  </Menu>
                );
                ContextMenu.show(menu, {
                  left: event.clientX,
                  top: event.clientY,
                });
              }}
              edgeUpdaterRadius={20} // default is 10
              onMoveEnd={(flowTransform) =>
                localStorage.setItem(
                  `flowgraph-state-${graphId}`,
                  JSON.stringify(flowTransform),
                )
              }
              // TODO: watch API change to fix issue with drag stophttps://github.com/wbkd/react-flow/issues/1314
              onNodeDragStop={(e, node) => {
                // Drag stop for individual node or multi node select
                // Bug with multi node select
                proGraph.moveNode(node.id, node.position);
              }}
              onSelectionDragStop={(e, nodes) => {
                // Drag stop for area selection
                for (const node of nodes) {
                  proGraph.moveNode(node.id, node.position);
                }
              }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
              <Controls style={{ bottom: "unset", top: "10px" }} />
              {!sideMenuOpen ? (
                <div
                  style={{
                    position: "absolute",
                    top: "10px",
                    right: "10px",
                    background: "white",
                    borderRadius: "100%",
                    zIndex: 1000,
                  }}
                  onClick={() => setSideMenuOpen(true)}
                >
                  <Icon icon="double-chevron-left" iconSize={20} />
                </div>
              ) : (
                ""
              )}
              <div
                style={{
                  position: "absolute",
                  bottom: "10px",
                  left: "10px",
                  background: "white",
                  borderRadius: "100%",
                  zIndex: 1000,
                }}
                onClick={() => setBottomMenuOpen((prev) => !prev)}
              >
                <Icon
                  icon={
                    bottomMenuOpen ? "double-chevron-down" : "double-chevron-up"
                  }
                  iconSize={20}
                />
              </div>

              <Drawer
                icon="multi-select"
                onClose={() => setSideMenuOpen(false)}
                title="Selected Elements"
                isOpen={sideMenuOpen}
                size={DrawerSize.SMALL}
                hasBackdrop={false}
                canOutsideClickClose={false}
                canEscapeKeyClose={false}
                enforceFocus={false}
                portalClassName="info-sidebar"
              >
                <div className={Classes.DRAWER_BODY}>
                  <div className={Classes.DIALOG_BODY}>
                    {selectedElements.length ? (
                      selectedElements.map((el, i) => (
                        <ElementInfoMenuItem key={i} element={el} />
                      ))
                    ) : (
                      <div>No elements selected.</div>
                    )}
                  </div>
                </div>
              </Drawer>
            </ReactFlow>
          </GraphInternals.Provider>
        )}
      </div>

      <HotkeysTarget2
        hotkeys={[
          {
            combo: "shift+n",
            global: true,
            label: "New graph",
            allowInInput: false,
            onKeyDown: () => {
              setShowNewDialog(true);
            },
          },
        ]}
      >
        <div></div>
      </HotkeysTarget2>

      <HotkeysTarget2
        hotkeys={[
          {
            combo: "shift+o",
            global: true,
            label: "Open graph",
            allowInInput: false,
            onKeyDown: () => {
              setShowSelectDialog(true);
            },
          },
        ]}
      >
        <div></div>
      </HotkeysTarget2>

      <HotkeysTarget2
        hotkeys={[
          {
            combo: "n",
            global: true,
            label: "Show Omnibar",
            allowInInput: false,
            onKeyDown: () => {
              setShowNodeOmniBar(true);
            },
            preventDefault: true,
          },
        ]}
      >
        <NodeOmnibar
          noResults={<MenuItem disabled={true} text="No results." />}
          items={nodeTypeList}
          query={omnibarQuery}
          onQueryChange={(q, _event) => setOmnibarQuery(q)}
          itemRenderer={renderNodeType}
          itemPredicate={filterNodeTypes}
          onItemSelect={(item) => {
            const { type, data } = item;
            addNode({
              type,
              data,
              position: getCanvasPosition(mousePosition.current),
            });
            setShowNodeOmniBar(false);
          }}
          onClose={() => {
            setShowNodeOmniBar(false);
          }}
          isOpen={showNodeOmniBar}
          resetOnSelect={true}
        />
      </HotkeysTarget2>

      {bottomMenuOpen ? (
        <div style={{ height: "35%" }}>
          {spreadsheetTableData ? (
            <Spreadsheet
              initialData={spreadsheetTableData.initialData}
              onDataUpdate={async (columnData, rowData) => {
                const columns = columnData;
                const rows = rowData;
                proGraph.updateNodeSources(spreadsheetTableData.nodeId, {
                  table: {
                    columns,
                    rows,
                  },
                });
              }}
            />
          ) : (
            "Must select a source node"
          )}
        </div>
      ) : (
        ""
      )}
    </div>
  );
};

export default FlowGraph;
