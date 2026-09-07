def run(data):
    rows = get(data, 'rows')
    observed = get(data, 'observed', {})
    require(is_list(rows) and 1 <= len(rows) <= 128, 'provide 1..128 prediction vectors')
    require(is_list(rows[0]) and 1 <= len(rows[0]) <= 128, 'provide 1..128 questions')
    width = len(rows[0])
    require(is_dict(observed), 'observed must be an object')
    for row in rows:
        require(is_list(row) and len(row) == width, 'ragged predictions')
        for value in row:
            require(is_str(value), 'categorical predictions only')
    allowed = []
    for j in range(width):
        append(allowed, str(j))
    for key in keys(observed):
        require(key in allowed and is_str(observed[key]), 'unknown question or noncategorical observation')
    survivors = []
    for i in range(len(rows)):
        fits = True
        for j in range(width):
            if str(j) in observed and rows[i][j] != observed[str(j)]:
                fits = False
        if fits:
            append(survivors, i)
    partitions = []
    for j in range(width):
        groups = {}
        for i in survivors:
            put(groups, rows[i][j], get(groups, rows[i][j], 0) + 1)
        counts = []
        for label in sorted(keys(groups)):
            append(counts, groups[label])
        append(partitions, counts)
    return {'survivors': survivors, 'partitions': partitions}
