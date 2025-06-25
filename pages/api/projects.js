// pages/api/projects.js
//
// This is a Next.js API route. It acts as our secure backend.
// When the frontend calls `/api/projects`, this server-side code runs,
// connects to Neo4j, fetches the data, and sends it back to the frontend.

import neo4j from 'neo4j-driver';

export default async function handler(req, res) {
  // Ensure we only handle GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  // Securely get credentials from environment variables
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;

  // Check if credentials are set
  if (!uri || !user || !password) {
    console.error('Neo4j credentials are not set in environment variables.');
    return res.status(500).json({ message: 'Server configuration error.' });
  }

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session = driver.session({ database: 'neo4j' });

  try {
    // This Cypher query fetches the top 10 projects, ordered by their Bloodhound Score
    const query = `
      MATCH (p:Project)
      WHERE p.bloodhound_score IS NOT NULL
      RETURN
        p.project_id AS id,
        p.name AS name,
        p.description AS description,
        p.bloodhound_score AS score,
        p.stars_delta_1d AS velocity
      ORDER BY p.bloodhound_score DESC
      LIMIT 10
    `;

    const result = await session.run(query);
    
    // Format the data into a clean JSON array
    const projects = result.records.map(record => ({
      id: record.get('id'),
      name: record.get('name'),
      description: record.get('description'),
      score: record.get('score'),
      velocity: record.get('velocity'),
    }));

    res.status(200).json(projects);

  } catch (error) {
    console.error('Error fetching data from Neo4j:', error);
    res.status(500).json({ message: 'Error fetching data.' });
  } finally {
    await session.close();
    await driver.close();
  }
}
