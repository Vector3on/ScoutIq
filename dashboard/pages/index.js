import React from 'react';
import Link from 'next/link';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

export async function getStaticProps() {
  let neo4j;
  try {
    neo4j = require('neo4j-driver');
  } catch (e) {
    console.error('Failed to load neo4j-driver. Ensure it is installed in your dashboard/package.json.', e);
    return { props: { projects: [], error: 'Server dependency (neo4j-driver) failed to load.' } };
  }

  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;

  console.log("Build Step: Starting getStaticProps...");
  if (!uri || !user || !password) {
    console.error("Build Step: CRITICAL - Neo4j credentials missing.");
    return { props: { projects: [], error: 'Server configuration error: Database credentials missing.' } };
  }
  console.log("Build Step: Neo4j credentials found.");

  let driver;
  try {
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    const session = driver.session({ database: 'neo4j' });

    const result = await session.run(`
      MATCH (p:Project) WHERE p.bloodhound_score IS NOT NULL
      RETURN p.project_id AS id, p.name AS name, p.description AS description,
             p.bloodhound_score AS score, p.stars_delta_1d AS velocity
      ORDER BY p.bloodhound_score DESC LIMIT 10
    `);

    const toNumber = (value) => {
      if (value == null) return 0;
      if (typeof value.toNumber === 'function') return value.toNumber();
      if (typeof value === 'number') return value;
      try {
        return neo4j.int(value).toNumber();
      } catch {
        return 0;
      }
    };

    const projects = result.records.map(record => ({
      id: record.get('id') || `fallback-id-${Math.random()}`,
      name: record.get('name') || 'Unknown Project',
      description: record.get('description') || 'No description available.',
      score: toNumber(record.get('score')),
      velocity: toNumber(record.get('velocity')),
    }));

    await session.close();
    console.log(`Build Step: Successfully fetched and sanitized ${projects.length} projects.`);
    return { props: { projects, error: null }, revalidate: 3600 };
  } catch (error) {
    console.error("Build Step: ERROR during data fetch:", error);
    return { props: { projects: [], error: `Database connection failed: ${error.message}` } };
  } finally {
    if (driver) await driver.close();
  }
}

const Header = () => (
  <header className="bg-gray-900 text-white p-4 flex justify-between items-center shadow-md z-20 sticky top-0">
    <div className="flex items-center space-x-3">
      <h1 className="text-xl font-bold tracking-wider">Project Bloodhound</h1>
    </div>
    <nav className="space-x-4">
      <Link href="/">
        <span className="text-gray-300 hover:text-white transition">Dashboard</span>
      </Link>
      <Link href="/search">
        <span className="text-indigo-400 hover:text-white font-semibold transition">Semantic Search</span>
      </Link>
    </nav>
  </header>
);

const StatCard = ({ title, value }) => (
  <div className="bg-gray-800 p-6 rounded-xl shadow-lg border border-gray-700">
    <h3 className="text-sm font-medium text-gray-400">{title}</h3>
    <p className="text-3xl font-bold text-white mt-1">{value}</p>
  </div>
);

const ErrorDisplay = ({ error }) => (
  <div className="flex-1 p-8 text-center">
    <h2 className="text-2xl font-bold text-red-400 mb-4">Live Data Error</h2>
    <div className="bg-red-900/20 border border-red-500 text-red-300 p-4 rounded-lg text-left">
      <p className="font-bold mb-2">Could not fetch data from the database during deployment.</p>
      <p className="text-sm mt-4">**Action Required:** Please double-check the `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD` environment variables in your Vercel project settings and redeploy.</p>
      <code className="block bg-gray-900 p-2 rounded text-xs text-gray-400 overflow-x-auto mt-2">
        Error Details: {error}
      </code>
    </div>
  </div>
);

const DashboardContent = ({ projects, error }) => {
  if (error) return <ErrorDisplay error={error} />;
  if (!projects) return <div className="p-8 text-center">Loading data...</div>;

  const chartData = projects.map(p => ({ name: p.name.split('/')[1] || p.name, score: p.score })).sort((a, b) => b.score - a.score);
  const totalProjects = projects.length;
  const highestScore = totalProjects > 0 ? Math.max(...projects.map(p => p.score)) : 0;

  return (
    <main className="flex-1 p-4 sm:p-6 lg:p-8 bg-gray-900 text-white overflow-y-auto">
      <h2 className="text-3xl font-bold mb-6">Market Overview</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-6 mb-8">
        <StatCard title="Top Tracked Projects" value={totalProjects} />
        <StatCard title="Highest Score" value={highestScore.toFixed(2)} />
      </div>
      <div className="bg-gray-800 rounded-xl p-6 shadow-lg border border-gray-700">
        <h3 className="text-xl font-bold mb-4">Project Scores</h3>
        <div style={{ width: '100%', height: 400 }}>
          <ResponsiveContainer>
            <BarChart data={chartData} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="name" stroke="#9CA3AF" />
              <YAxis yAxisId="left" orientation="left" stroke="#9CA3AF" />
              <Tooltip contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #4B5563' }} />
              <Legend />
              <Bar yAxisId="left" dataKey="score" fill="#4F46E5" name="Bloodhound Score" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </main>
  );
};

export default function App({ projects, error }) {
  return (
    <div className="flex h-screen bg-gray-900 font-sans">
      <div className="flex flex-col flex-1 w-full">
        <Header />
        <DashboardContent projects={projects} error={error} />
      </div>
    </div>
  );
}
