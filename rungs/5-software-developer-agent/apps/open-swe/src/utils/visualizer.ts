import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { graph as plannerGraph } from "../graphs/planner/index.js";
import { graph as programmerGraph } from "../graphs/programmer/index.js";
import { graph as managerGraph } from "../graphs/manager/index.js";
import { createLogger, LogLevel } from "./logger.js";

const logger = createLogger(LogLevel.INFO, "GraphVisualizer");

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create images directory path relative to the project root (go up 4 levels: src/utils -> src -> open-swe -> apps -> root)
const projectRoot = join(__dirname, "../../../../");
const imagesDir = join(projectRoot, ".images");

interface GraphInfo {
  name: string;
  graph: any;
  fileName: string;
}

const graphs: GraphInfo[] = [
  {
    name: "Planner Graph",
    graph: plannerGraph,
    fileName: "planner-graph"
  },
  {
    name: "Programmer Graph", 
    graph: programmerGraph,
    fileName: "programmer-graph"
  },
  {
    name: "Manager Graph",
    graph: managerGraph,
    fileName: "manager-graph"
  }
];

async function ensureImagesDirectory(): Promise<void> {
  if (!existsSync(imagesDir)) {
    logger.info(`Creating images directory: ${imagesDir}`);
    mkdirSync(imagesDir, { recursive: true });
  }
}

async function generateMermaidDiagram(graphInfo: GraphInfo): Promise<void> {
  try {
    logger.info(`Generating Mermaid diagram for ${graphInfo.name}`);
    
    // Get the drawable graph representation
    const drawableGraph = await graphInfo.graph.getGraphAsync();
    
    // Generate a clean, simple Mermaid diagram
    const mermaidCode = generateCleanMermaidFromGraph(drawableGraph);
    
    // Write Mermaid code to file
    const mermaidPath = join(imagesDir, `${graphInfo.fileName}.mmd`);
    writeFileSync(mermaidPath, mermaidCode);
    logger.info(`Saved Mermaid diagram: ${mermaidPath}`);
    
  } catch (error) {
    logger.error(`Error generating Mermaid diagram for ${graphInfo.name}:`, error);
  }
}

function generateCleanMermaidFromGraph(drawableGraph: any): string {
  const nodes = drawableGraph.nodes || {};
  const edges = drawableGraph.edges || [];
  
  // Start with proper JSON init block
  let mermaidCode = '%%{init: {"flowchart": {"curve": "linear"}}}%%\n';
  mermaidCode += 'graph TD;\n';
  
  // Add node definitions with inline class application
  Object.keys(nodes).forEach(nodeId => {
    const node = nodes[nodeId];
    const label = node.data?.name || nodeId;
    const cleanLabel = label.replace(/-/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    
    if (nodeId === '__start__') {
      mermaidCode += `\t${nodeId}([${cleanLabel || 'Start'}]):::startNode\n`;
    } else if (nodeId === '__end__') {
      mermaidCode += `\t${nodeId}([${cleanLabel || 'End'}]):::endNode\n`;
    } else {
      // Clean node ID by removing hyphens for valid Mermaid syntax
      const cleanNodeId = nodeId.replace(/-/g, '');
      mermaidCode += `\t${cleanNodeId}[${cleanLabel}]\n`;
    }
  });
  
  mermaidCode += '\n';
  
  // Add edges - determine conditional vs regular edges based on edge properties
  // In LangGraph, conditional edges often come from the same source to multiple targets
  const edgesBySource: Record<string, any[]> = {};
  edges.forEach((edge: any) => {
    const source = edge.source;
    if (!edgesBySource[source]) {
      edgesBySource[source] = [];
    }
    edgesBySource[source].push(edge);
  });
  
  const regularEdges: any[] = [];
  const conditionalEdges: any[] = [];
  
  Object.keys(edgesBySource).forEach(source => {
    const sourceEdges = edgesBySource[source];
    if (sourceEdges.length > 1) {
      // If a node has multiple outgoing edges, treat them as conditional
      conditionalEdges.push(...sourceEdges);
    } else {
      // Single outgoing edge is regular
      regularEdges.push(...sourceEdges);
    }
  });
  
  // Add regular edges first
  regularEdges.forEach((edge: any) => {
    const source = edge.source;
    const target = edge.target;
    
    const sourceId = (source === '__start__' || source === '__end__') ? source : source.replace(/-/g, '');
    const targetId = (target === '__start__' || target === '__end__') ? target : target.replace(/-/g, '');
    
    mermaidCode += `\t${sourceId} --> ${targetId}\n`;
  });
  
  // Add conditional edges (dotted lines)
  if (conditionalEdges.length > 0) {
    mermaidCode += '\n';
    conditionalEdges.forEach((edge: any) => {
      const source = edge.source;
      const target = edge.target;
      
      const sourceId = (source === '__start__' || source === '__end__') ? source : source.replace(/-/g, '');
      const targetId = (target === '__start__' || target === '__end__') ? target : target.replace(/-/g, '');
      
      mermaidCode += `\t${sourceId} -.-> ${targetId}\n`;
    });
  }
  
  // Add proper CSS styling with fill: prefix
  mermaidCode += '\n';
  mermaidCode += '\tclassDef startNode fill:#90EE90,stroke:#333,stroke-width:2px;\n';
  mermaidCode += '\tclassDef endNode fill:#FFB6C1,stroke:#333,stroke-width:2px;\n';
  
  return mermaidCode;
}

async function generatePngImage(graphInfo: GraphInfo): Promise<void> {
  try {
    logger.info(`Generating PNG image for ${graphInfo.name}`);
    
    // Get the drawable graph representation
    const drawableGraph = await graphInfo.graph.getGraphAsync();
    
    // Generate PNG image as Blob
    const pngBlob = await drawableGraph.drawMermaidPng({
      withStyles: true,
      curveStyle: "linear", 
      nodeColors: {
        "__start__": "#90EE90",
        "__end__": "#FFB6C1"
      },
      wrapLabelNWords: 3,
      backgroundColor: "white"
    });
    
    // Convert blob to buffer and save
    const buffer = Buffer.from(await pngBlob.arrayBuffer());
    const pngPath = join(imagesDir, `${graphInfo.fileName}.png`);
    writeFileSync(pngPath, buffer);
    logger.info(`Saved PNG image: ${pngPath}`);
    
  } catch (error) {
    logger.warn(`PNG generation failed for ${graphInfo.name} (external API issue):`, (error as Error).message);
    logger.info(`Mermaid diagram (.mmd file) is still available for ${graphInfo.name}`);
  }
}

export async function visualizeGraphs(): Promise<void> {
  try {
    logger.info("Starting graph visualization process");
    
    // Ensure images directory exists
    await ensureImagesDirectory();
    
    // Generate visualizations for each graph
    for (const graphInfo of graphs) {
      logger.info(`Processing ${graphInfo.name}`);
      
      // Generate both Mermaid and PNG formats
      await Promise.all([
        generateMermaidDiagram(graphInfo),
        generatePngImage(graphInfo)
      ]);
    }
    
    logger.info(`Graph visualization completed! Files saved to: ${imagesDir}`);
    logger.info("Generated Mermaid diagram files (.mmd):");
    for (const graphInfo of graphs) {
      logger.info(`  - ${graphInfo.fileName}.mmd`);
    }
    logger.info("Note: PNG files may not be generated if external Mermaid API is unavailable");
    
  } catch (error) {
    logger.error("Error during graph visualization:", error);
    throw error;
  }
}

// Allow running directly with Node.js
if (import.meta.url === `file://${process.argv[1]}`) {
  visualizeGraphs()
    .then(() => {
      logger.info("Visualization completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      logger.error("Visualization failed:", error);
      process.exit(1);
    });
}
