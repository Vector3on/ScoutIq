def matches(state, pattern):
    for i in range(len(state)):
        if pattern[i] is not None and pattern[i] != state[i]:
            return False
    return True

def run(data):
    initial = get(data, 'initial')
    goal = get(data, 'goal')
    actions = get(data, 'actions')
    limit = get(data, 'max_expansions', 1024)
    require(is_list(initial) and 1 <= len(initial) <= 10, 'initial must contain 1..10 binary facts')
    n = len(initial)
    for value in initial:
        require(is_int(value) and value in [0, 1], 'initial facts must be integer 0 or 1')
    require(is_list(goal) and len(goal) == n, 'goal length must match state')
    require(is_list(actions) and len(actions) <= 32, 'provide at most 32 actions')
    require(is_int(limit) and 1 <= limit <= 1024, 'max_expansions must be 1..1024')
    names = set()
    patterns = [goal]
    for action in actions:
        name = get(action, 'name')
        require(is_str(name) and name not in names, 'action names must be unique strings')
        add(names, name)
        require(is_int(get(action, 'cost')) and 1 <= action['cost'] <= 1000, 'cost must be integer 1..1000')
        append(patterns, get(action, 'pre'))
        append(patterns, get(action, 'effect'))
    for pattern in patterns:
        require(is_list(pattern) and len(pattern) == n, 'precondition/effect/goal lengths must match')
        for value in pattern:
            require(value is None or (is_int(value) and value in [0, 1]), 'patterns contain only null, 0, 1')
    start = tuple(initial)
    frontier = [(0, start)]
    distance = {start: 0}
    parents = {}
    expanded = 0
    while len(frontier) > 0:
        frontier = sorted(frontier)
        item = frontier[0]
        frontier = frontier[1:]
        cost = item[0]
        state = item[1]
        if distance[state] != cost:
            continue
        if matches(state, goal):
            plan = []
            states = [list(state)]
            cursor = state
            while cursor != start:
                record = parents[cursor]
                append(plan, record[1])
                cursor = record[0]
                append(states, list(cursor))
            return {'outcome': 'solved', 'plan': plan[::-1], 'states': states[::-1], 'cost': cost, 'expanded': expanded}
        if expanded >= limit:
            return {'outcome': 'budget_exhausted', 'expanded': expanded, 'frontier_lower_bound': cost}
        expanded += 1
        for action in actions:
            if not matches(state, action['pre']):
                continue
            nextstate = list(state)
            for i in range(n):
                if action['effect'][i] is not None:
                    nextstate[i] = action['effect'][i]
            nextstate = tuple(nextstate)
            newcost = cost + action['cost']
            if nextstate not in distance or newcost < distance[nextstate]:
                put(distance, nextstate, newcost)
                put(parents, nextstate, [state, action['name']])
                append(frontier, (newcost, nextstate))
    return {'outcome': 'unreachable', 'expanded': expanded}
