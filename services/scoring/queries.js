export const SEARCH_QUERIES = [
  {
    id: 'js_dependency_pain',
    query: 'package.json stars:50..2000 pushed:>2024-01-01',
    languages: ['JavaScript', 'TypeScript'],
    sort: 'updated',
  },
  {
    id: 'ts_ci_failures',
    query: '"build failed" language:TypeScript stars:50..2000 pushed:>2024-06-01',
    languages: ['TypeScript'],
    sort: 'updated',
  },
  {
    id: 'bug_heavy_repos',
    query: 'label:bug stars:50..2000 pushed:>2024-06-01',
    languages: ['JavaScript', 'TypeScript', 'Python'],
    sort: 'updated',
  },
  {
    id: 'active_maintenance',
    query: '"fix" language:JavaScript stars:50..2000 pushed:>2024-03-01',
    languages: ['JavaScript', 'TypeScript'],
    sort: 'updated',
  },
  {
    id: 'python_deps',
    query: 'requirements.txt stars:50..2000 language:Python pushed:>2024-01-01',
    languages: ['Python'],
    sort: 'updated',
  },
  {
    id: 'help_wanted_bugs',
    query: 'label:"help wanted" label:bug stars:50..2000',
    languages: ['JavaScript', 'TypeScript', 'Python'],
    sort: 'updated',
  },
  {
    id: 'npm_outdated',
    query: '"outdated" "package.json" stars:50..2000 pushed:>2024-06-01',
    languages: ['JavaScript', 'TypeScript'],
    sort: 'updated',
  },
];
