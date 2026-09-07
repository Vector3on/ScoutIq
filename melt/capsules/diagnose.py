def optimize(survivors, tests, names, memo, tracker, limit):
    key = tuple(survivors)
    if key in memo:
        return memo[key]
    if len(survivors) == 1:
        return {'cost': 0, 'tree': {'hypothesis': names[survivors[0]]}}
    if tracker['expanded'] >= limit:
        put(tracker, 'exhausted', True)
        return {'cost': None}
    put(tracker, 'expanded', tracker['expanded'] + 1)
    best = None
    for test in tests:
        groups = {}
        for i in survivors:
            label = test['outcomes'][i]
            if label not in groups:
                put(groups, label, [])
            append(groups[label], i)
        if len(groups) <= 1:
            continue
        worst = 0
        branches = {}
        for label in sorted(keys(groups)):
            result = optimize(groups[label], tests, names, memo, tracker, limit)
            if get(tracker, 'exhausted', False):
                return {'cost': None}
            worst = max(worst, result['cost'])
            put(branches, label, result['tree'])
        cost = test['cost'] + worst
        if best is None or cost < best['cost']:
            best = {'cost': cost, 'tree': {'test': test['name'], 'branches': branches}}
    put(memo, key, best)
    return best

def run(data):
    names = get(data, 'hypotheses')
    tests = get(data, 'tests')
    observed = get(data, 'observed', {})
    limit = get(data, 'max_subsets', 256)
    require(is_list(names) and 1 <= len(names) <= 8, 'provide 1..8 hypothesis names')
    seen = set()
    for name in names:
        require(is_str(name) and name not in seen, 'hypothesis names must be unique strings')
        add(seen, name)
    require(is_list(tests) and len(tests) <= 8, 'provide at most 8 tests')
    require(is_dict(observed), 'observed must be an object')
    require(is_int(limit) and 1 <= limit <= 256, 'max_subsets must be 1..256')
    seen = set()
    for test in tests:
        name = get(test, 'name')
        require(is_str(name) and name not in seen, 'test names must be unique strings')
        add(seen, name)
        require(is_int(get(test, 'cost')) and 1 <= test['cost'] <= 100, 'test cost must be integer 1..100')
        require(is_list(get(test, 'outcomes')) and len(test['outcomes']) == len(names), 'one predicted outcome per hypothesis')
        for outcome in test['outcomes']:
            require(is_str(outcome), 'outcomes must be strings')
    for name in keys(observed):
        require(name in seen and is_str(observed[name]), 'observations must name known tests and string outcomes')
    survivors = []
    for i in range(len(names)):
        fits = True
        for test in tests:
            if test['name'] in observed and test['outcomes'][i] != observed[test['name']]:
                fits = False
        if fits:
            append(survivors, i)
    if len(survivors) == 0:
        return {'outcome': 'inconsistent'}
    for a in survivors:
        for b in survivors:
            if a >= b:
                continue
            same = True
            for test in tests:
                if test['outcomes'][a] != test['outcomes'][b]:
                    same = False
            if same:
                return {'outcome': 'unidentifiable', 'witness': [names[a], names[b]]}
    tracker = {'expanded': 0, 'exhausted': False}
    result = optimize(survivors, tests, names, {}, tracker, limit)
    if tracker['exhausted']:
        return {'outcome': 'budget_exhausted', 'expanded_subsets': tracker['expanded']}
    return {'outcome': 'solved', 'worst_cost': result['cost'], 'policy': result['tree'],
            'expanded_subsets': tracker['expanded'], 'surviving_hypotheses': len(survivors)}
