// dashboard/pages/api/search.js
//
// Secure backend API route for semantic search with Neo4j + Transformers

import { pipeline } from '@xenova/transformers';
import neo4j from 'neo4j-driver';

// Cache model and driver to avoid reinitializing on each request
let modelPipeline = null;
let driver = null;

const initializeModel = async () => {
  if (!modelPipeline) {
    console.log("Initializing AI model for the first time...");
    modelPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log("AI model initialized successfully.");
  }
  return modelPipeline;
};

const getDriver = () => {
  if (!driver) {
    const uri = process.env.NEO4J_URI;
    const user = process.env.NEO4J_USERNAME;
    const password = process.env.NEO4J_PASSWORD;
    if (!uri || !user || !password) {
      throw new Error("Neo4j credentials are not set in environment variables.");
    }
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    console.log("Neo4j driver initialized.");
  }
  return driver;
};

const cosineSimilarity = (vecA, vecB) => {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const { query: searchQuery } = req.body;
  if (!searchQuery) {
    return res.status(400).json({ message: 'Search query is required.' });
  }

  try {
    const pipe = await initializeModel();
    const dbDriver = getDriver();
    const session = dbDriver.session({ database: 'neo4j' });

    const result = await session.run(`
      MATCH (p:Project)
      WHERE p.embedding IS NOT NULL AND p.name IS NOT NULL
      RETURN p.name AS name, p.description AS description, p.embedding AS embedding
    `);

    const projects = result.records.map(record => ({
      name: record.get('name'),
      description: record.get('description'),
      embedding: record.get('embedding'),
    }));

    if (projects.length === 0) {
      return res.status(200).json([]);
    }

    const queryEmbedding = (await pipe(searchQuery, { pooling: 'mean', normalize: true })).data;

    const rankedProjects = projects.map(project => ({
      ...project,
      similarity: cosineSimilarity(queryEmbedding, project.embedding),
    }));

    const topResults = rankedProjects
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);

    await session.close();
    res.status(200).json(topResults);
  } catch (error) {
    console.error('Error in semantic search API:', error);
    res.status(500).json({ message: `Internal Server Error: ${error.message}` });
  }
}
