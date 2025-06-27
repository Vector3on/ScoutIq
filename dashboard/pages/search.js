import React, { useState } from 'react';

// --- Reusable Components (can be moved to a components folder later) ---
const Header = () => (
  <header className="bg-gray-900 text-white p-4 flex justify-between items-center shadow-md z-20 sticky top-0">
    <div className="flex items-center space-x-3">
      <h1 className="text-xl font-bold tracking-wider">Project Bloodhound</h1>
    </div>
  </header>
);

const Sidebar = () => (
    <aside className="bg-gray-800 text-gray-300 w-64 p-4 shadow-lg">
      <nav className="mt-16">
        <ul>
          <li className="mb-2">
            <a href="/" className="flex items-center p-3 rounded-lg hover:bg-gray-700 transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>
              <span className="ml-3">Dashboard</span>
            </a>
          </li>
          <li className="mb-2">
            <a href="/search" className="flex items-center p-3 rounded-lg bg-gray-700 text-white font-bold">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <span className="ml-3">Semantic Search</span>
            </a>
          </li>
        </ul>
      </nav>
    </aside>
  );

const SearchResultCard = ({ project }) => (
    <div className="bg-gray-800 p-6 rounded-xl shadow-lg border border-gray-700 hover:border-indigo-500 transition-all">
        <div className="flex justify-between items-start">
            <h3 className="text-xl font-bold text-white">{project.name}</h3>
            <span className="bg-indigo-500/20 text-indigo-300 text-sm font-semibold px-3 py-1 rounded-full">
                Score: {project.similarity.toFixed(4)}
            </span>
        </div>
        <p className="text-gray-400 mt-2">{project.description}</p>
    </div>
);


const SearchPageContent = () => {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [searched, setSearched] = useState(false);

    const handleSearch = async (e) => {
        e.preventDefault();
        if (!query.trim()) return;

        setLoading(true);
        setError(null);
        setSearched(true);
        setResults([]);

        try {
            const response = await fetch('/api/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query }),
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.message || 'An error occurred during search.');
            }

            const data = await response.json();
            setResults(data);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <main className="flex-1 p-4 sm:p-6 lg:p-8 bg-gray-900 text-white overflow-y-auto">
            <h2 className="text-3xl font-bold mb-2">Semantic Search</h2>
            <p className="text-gray-400 mb-6">Discover projects based on meaning, not just keywords.</p>
            
            <form onSubmit={handleSearch} className="flex gap-4 mb-8">
                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="e.g., a tool for data visualization"
                    className="flex-grow bg-gray-800 border border-gray-700 rounded-lg p-3 focus:ring-2 focus:ring-indigo-500 focus:outline-none transition-all"
                />
                <button type="submit" disabled={loading} className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-900/50 disabled:cursor-not-allowed text-white font-bold py-3 px-6 rounded-lg transition-colors">
                    {loading ? 'Searching...' : 'Search'}
                </button>
            </form>

            {loading && <div className="text-center text-gray-400">Finding similar projects...</div>}
            {error && <div className="text-center text-red-400">Error: {error}</div>}
            
            <div className="space-y-4">
                {results.length > 0 && results.map((project) => (
                    <SearchResultCard key={project.name} project={project} />
                ))}
            </div>

            {searched && !loading && results.length === 0 && (
                <div className="text-center text-gray-500 mt-8">
                    <p>No results found for "{query}".</p>
                    <p className="text-sm">Try a different search term or make sure your data pipeline has run.</p>
                </div>
            )}
        </main>
    );
};

export default function SearchPage() {
  return (
    <div className="flex h-screen bg-gray-900 font-sans">
      <div className="hidden md:flex">
        <Sidebar />
      </div>
      <div className="flex flex-col flex-1 w-full">
        <Header />
        <SearchPageContent />
      </div>
    </div>
  );
}
