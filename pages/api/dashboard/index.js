import React, { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

// This special Next.js function runs on the server during the build process.
// It fetches the data from Neo4j and passes it to our dashboard component as props.
export async function getStaticProps() {
  let neo4j;
  try {
    // This server-side dependency is required only within this function.
    // Wrapping it in a try-catch can help with some build tool issues.
    neo4j = require('neo4j-driver');
  } catch (e) {
    console.error('Failed to load neo4j-driver. Ensure it is installed.', e);
    return { props: { projects: [], error: 'Server dependency (neo4j-driver) failed to load.' } };
  }
  
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;

  if (!uri || !user || !password) {
    console.error('Neo4j credentials are not set in environment variables.');
    // Return empty props if config is missing
    return { props: { projects: [], error: 'Server configuration error.' } };
  }

  let driver, session;
  try {
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    session = driver.session({ database: 'neo4j' });

    const query = `
      MATCH (p:Project)
      WHERE p.bloodhound_score IS NOT NULL
      RETURN p.project_id AS id, p.name AS name, p.description AS description,
             p.bloodhound_score AS score, p.stars_delta_1d AS velocity
      ORDER BY p.bloodhound_score DESC
      LIMIT 10
    `;
    const result = await session.run(query);
    const projects = result.records.map(record => ({
      id: record.get('id'),
      name: record.get('name'),
      description: record.get('description'),
      score: record.get('score'),
      velocity: record.get('velocity'),
    }));
    
    return {
      props: {
        projects, // This will be passed to the page component as props
      },
      // Re-generate the page at most once every hour to get fresh data
      revalidate: 3600, 
    };
  } catch (error) {
    console.error('Error in getStaticProps:', error);
    return { props: { projects: [], error: error.message } };
  } finally {
    if (session) await session.close();
    if (driver) await driver.close();
  }
}


// --- Components (No changes to these) ---
const MenuIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16m-7 6h7" />
  </svg>
);
const DashboardIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>
);
const GraphIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 18a10 10 0 0 0-4.9-8.5"/><path d="m12 2 4.9 8.5"/><path d="M2.2 13.2a10 10 0 0 0 4.9 8.5"/><path d="M21.8 13.2a10 10 0 0 1-4.9 8.5"/><path d="M12 18a10 10 0 0 1-4.9-8.5"/><path d="m12 2-4.9 8.5"/><path d="m2.2 6.8a10 10 0 0 1 4.9-8.5"/><path d="m21.8 6.8a10 10 0 0 0-4.9-8.5"/></svg>
);
const SearchIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
);
const Header = ({ onMenuClick }) => (
  <header className="bg-gray-900 text-white p-4 flex justify-between items-center shadow-md z-20 sticky top-0">
    <div className="flex items-center space-x-3">
      <img src="https://placehold.co/40x40/1a202c/ffffff?text=BH" alt="Bloodhound Logo" className="rounded-full" />
      <h1 className="text-xl font-bold tracking-wider">Project Bloodhound</h1>
    </div>
    <div className="md:hidden">
      <button onClick={onMenuClick} className="text-white focus:outline-none">
        <MenuIcon />
      </button>
    </div>
  </header>
);
const Sidebar = ({ isOpen }) => (
  <aside className={`bg-gray-800 text-gray-300 w-64 fixed inset-y-0 left-0 transform ${isOpen ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0 transition-transform duration-300 ease-in-out z-10 p-4 shadow-lg`}>
    <nav className="mt-16">
      <ul>
        <li className="mb-2"><a href="#" className="flex items-center p-3 rounded-lg bg-gray-700 text-white font-bold"><DashboardIcon /><span className="ml-3">Dashboard</span></a></li>
        <li className="mb-2"><a href="#" className="flex items-center p-3 rounded-lg hover:bg-gray-700 transition-colors"><GraphIcon /><span className="ml-3">Graph Explorer</span></a></li>
        <li className="mb-2"><a href="#" className="flex items-center p-3 rounded-lg hover:bg-gray-700 transition-colors"><SearchIcon /><span className="ml-3">Semantic Search</span></a></li>
      </ul>
    </nav>
  </aside>
);
const StatCard = ({ title, value, change }) => {
    return (
        <div className="bg-gray-800 p-6 rounded-xl shadow-lg border border-gray-700">
            <h3 className="text-sm font-medium text-gray-400">{title}</h3>
            <p className="text-3xl font-bold text-white mt-1">{value}</p>
            {change != null && ( <p className={`text-sm mt-2 flex items-center ${change >= 0 ? 'text-green-400' : 'text-red-400'}`}> <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"> {change >= 0 ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7l5 5m0 0l-5 5m5-5H6" /> : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 17l-5-5m0 0l5-5m-5 5h12" />} </svg> {Math.abs(change)} in last 24h </p> )}
        </div>
    );
};
const DashboardContent = ({ projects, error }) => {
    // No longer need loading or client-side fetching state
    if (error) {
        return <div className="flex-1 p-8 text-center text-red-400">Error: {error}</div>
    }

    const chartData = projects.map(p => ({
        name: p.name.split('/')[1],
        score: p.score,
        velocity: p.velocity,
    })).sort((a,b) => b.score - a.score);
    
    const totalProjects = projects.length;
    const totalVelocity = projects.reduce((acc, p) => acc + (p.velocity || 0), 0);
    const highestScore = projects.length > 0 ? Math.max(...projects.map(p => p.score)) : 0;

    return (
        <main className="flex-1 p-4 sm:p-6 lg:p-8 bg-gray-900 text-white overflow-y-auto">
            <h2 className="text-3xl font-bold mb-6">Market Overview</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <StatCard title="Top Tracked Projects" value={totalProjects} />
                <StatCard title="Total Star Velocity" value={totalVelocity} change={totalVelocity} />
                <StatCard title="New Signals (24h)" value="-" />
                <StatCard title="Highest Score" value={highestScore.toFixed(2)} />
            </div>
            <div className="bg-gray-800 rounded-xl p-6 shadow-lg border border-gray-700 mb-8">
                 <h3 className="text-xl font-bold mb-4">Project Score & Velocity</h3>
                 <div style={{ width: '100%', height: 400 }}>
                    <ResponsiveContainer>
                        <BarChart data={chartData} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                            <XAxis dataKey="name" stroke="#9CA3AF" />
                            <YAxis yAxisId="left" orientation="left" stroke="#9CA3AF" />
                            <YAxis yAxisId="right" orientation="right" stroke="#9CA3AF" />
                            <Tooltip contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #4B5563' }} />
                            <Legend />
                            <Bar yAxisId="left" dataKey="score" fill="#4F46E5" name="Bloodhound Score" />
                            <Bar yAxisId="right" dataKey="velocity" fill="#10B981" name="Star Velocity (24h)" />
                        </BarChart>
                    </ResponsiveContainer>
                 </div>
            </div>
            <div>
                <h3 className="text-xl font-bold mb-4">Top Ranked Projects</h3>
                <div className="overflow-x-auto bg-gray-800 rounded-xl shadow-lg border border-gray-700">
                    <table className="w-full text-left">
                        <thead className="border-b border-gray-700">
                            <tr>
                                <th className="p-4">Rank</th>
                                <th className="p-4">Project</th>
                                <th className="p-4 hidden md:table-cell">Description</th>
                                <th className="p-4">Score</th>
                                <th className="p-4">Velocity</th>
                            </tr>
                        </thead>
                        <tbody>
                            {projects.map((project, index) => (
                                <tr key={project.id} className="border-b border-gray-700 last:border-0 hover:bg-gray-700/50 transition-colors">
                                    <td className="p-4 font-bold text-lg">{index + 1}</td>
                                    <td className="p-4 font-semibold">{project.name}</td>
                                    <td className="p-4 text-gray-400 hidden md:table-cell">{project.description}</td>
                                    <td className="p-4 font-bold text-indigo-400">{project.score.toFixed(2)}</td>
                                    <td className="p-4 font-bold text-green-400">+{project.velocity || 0}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </main>
    );
};

// The main App component now receives the projects and error data as props from getStaticProps
export default function App({ projects, error }) {
  const [isSidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen bg-gray-900 font-sans">
      <Sidebar isOpen={isSidebarOpen} />
      <div className="flex flex-col flex-1 w-full">
        <Header onMenuClick={() => setSidebarOpen(!isSidebarOpen)} />
        <DashboardContent projects={projects} error={error} />
      </div>
    </div>
  );
}
