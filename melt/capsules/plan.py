def visit(name, tasks, state, indices, lows, stack, active, cycles):
    put(indices, name, state['index'])
    put(lows, name, state['index'])
    put(state, 'index', state['index'] + 1)
    append(stack, name)
    put(active, name, True)
    for dep in tasks[name]:
        if dep not in indices:
            visit(dep, tasks, state, indices, lows, stack, active, cycles)
            put(lows, name, min(lows[name], lows[dep]))
        elif get(active, dep, False):
            put(lows, name, min(lows[name], indices[dep]))
    if lows[name] == indices[name]:
        component = []
        while True:
            member = pop(stack)
            put(active, member, False)
            append(component, member)
            if member == name:
                break
        if len(component) > 1 or name in tasks[name]:
            for member in component:
                add(cycles, member)

def run(data):
    tasks = get(data, 'tasks')
    require(is_dict(tasks) and len(tasks) <= 128, 'tasks must be an object with at most 128 entries')
    for name in keys(tasks):
        require(is_list(tasks[name]), 'dependencies must be lists')
        for dep in tasks[name]:
            require(is_str(dep) and dep in tasks, 'unknown dependency')
    done = set()
    layers = []
    while len(done) < len(tasks):
        ready = []
        for name in sorted(keys(tasks)):
            if name in done:
                continue
            satisfied = True
            for dep in tasks[name]:
                if dep not in done:
                    satisfied = False
            if satisfied:
                append(ready, name)
        if len(ready) == 0:
            break
        append(layers, ready)
        for name in ready:
            add(done, name)
    blocked = []
    for name in sorted(keys(tasks)):
        if name not in done:
            append(blocked, name)
    cycles = set()
    state = {'index': 0}
    indices = {}
    lows = {}
    active = {}
    stack = []
    for name in sorted(keys(tasks)):
        if name not in indices:
            visit(name, tasks, state, indices, lows, stack, active, cycles)
    return {'layers': layers, 'blocked': blocked, 'cycle_nodes': sorted(list(cycles))}
