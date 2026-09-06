def run(data):
    perception = use('objects', data)
    tasks = {}
    summaries = []
    for i in range(len(perception['objects'])):
        obj = perception['objects'][i]
        name = 'object-' + str(i)
        put(tasks, name, [])
        append(summaries, {'id': name, 'color': obj['color'], 'area': obj['area'], 'bbox': obj['bbox']})
    put(tasks, 'compose-scene', sorted(keys(tasks)))
    schedule = use('plan', {'tasks': tasks})
    return {'objects': summaries, 'schedule': schedule,
            'height': perception['height'], 'width': perception['width']}
