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
    return {'layers': layers, 'blocked': blocked, 'cycle_nodes': blocked}
