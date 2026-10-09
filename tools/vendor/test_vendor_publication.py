"""Offline publication regression: python3 -B tools/vendor/test_vendor_publication.py."""
import io
import json
import tempfile
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import vendor_events
import vendor_banners
import vendor_raid_banners


def check_publication(module, failure):
    with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
        root = Path(directory)
        banners = root / 'banners'
        banners.mkdir()
        for name in ('old.webp', 'new.webp', 'raid.webp'):
            (banners / name).write_bytes(name.encode())
        event = {'id': 'test', 'title': 'Misaki 픽업', 'category': 'pickup',
                 'start': '2026-09-29T11:00:00+09:00', 'servers': ['gl'], 'images': {'jp': 'old.webp'}}
        target = root / 'events.json'
        original = json.dumps({'schema_version': 1, 'events': [event]}).encode()
        target.write_bytes(original)
        stack.enter_context(patch.object(module, 'BANNER_DIR', str(banners)))
        stack.enter_context(patch.object(module, 'raid_assets', return_value={'raid.webp'}))
        # Any unexpected subprocess/network operation fails this offline check.
        def which_only(args, **kwargs):
            assert args == ['which', 'cwebp'], args
            return SimpleNamespace(returncode=0)
        stack.enter_context(patch.object(module.subprocess, 'run', side_effect=which_only))
        if module is vendor_events:
            new = {**event, 'images': {'jp': 'new.webp'}}
            stack.enter_context(patch.object(module, 'OUT', str(target)))
            stack.enter_context(patch.object(module, 'IMAGES', {'image-url': 'new.webp'}))
            stack.enter_context(patch.object(module, 'page', return_value=''))
            stack.enter_context(patch.object(module, 'event_rows', return_value=[new]))
            for name in ('simple_rows', 'campaign_rows', 'raid_rows', 'banner_rows', 'jp_campaign_notices'):
                stack.enter_context(patch.object(module, name, return_value=[]))
        else:
            stack.enter_context(patch.object(module, 'EVENTS', str(target)))
            stack.enter_context(patch.object(module.sys, 'argv', ['vendor_banners.py']))
            for name in ('student_names', 'cn_news_rows', 'match_kr_forum', 'kr_microsites', 'jp_news_ids'):
                stack.enter_context(patch.object(module, name, return_value={}))
            stack.enter_context(patch.object(module, 'match_cn', return_value={'test': ('Misaki', '1', 'image-url')}))
            stack.enter_context(patch.object(vendor_raid_banners, 'ensure_kr_assets', return_value=0))
            def attach(events, picked, lang, name_of):
                if picked:
                    events[0]['images'] = {lang: 'new.webp'}
                return len(picked)
            stack.enter_context(patch.object(module, 'attach', side_effect=attach))

        if failure == 'dump':
            def partial_dump(bundle, handle, **kwargs):
                handle.write('{"schema_version":')
                raise OSError('injected write failure')
            stack.enter_context(patch.object(vendor_events.json, 'dump', side_effect=partial_dump))
        elif failure == 'replace':
            def failed_replace(source, destination):
                assert Path(source).parent == target.parent, 'temp must be a sibling'
                assert json.loads(Path(source).read_text())['schema_version'] == 1, 'temp must be complete'
                assert str(destination) == str(target)
                raise OSError('injected replace failure')
            stack.enter_context(patch.object(vendor_events.os, 'replace', side_effect=failed_replace))
        try:
            with redirect_stdout(io.StringIO()):
                module.main()
        except OSError:
            assert failure, 'successful publication must not raise'
        else:
            assert not failure, 'injected failure must propagate'

        if failure:
            assert target.read_bytes() == original, 'old bundle must survive failed publication'
            assert (banners / 'old.webp').read_bytes() == b'old.webp', 'old referenced asset must survive'
        else:
            published = json.loads(target.read_text())
            assert published['events'][0]['images'] in ({'jp': 'new.webp'}, {'zh': 'new.webp'})
            assert not (banners / 'old.webp').exists(), 'pruning must run after successful publication'
        assert (banners / 'new.webp').exists()
        assert (banners / 'raid.webp').exists(), 'shared raid art must be protected'
        assert sorted(path.name for path in root.iterdir()) == ['banners', 'events.json'], 'temp must be cleaned'


if __name__ == '__main__':
    for module in (vendor_events, vendor_banners):
        for failure in ('dump', 'replace', None):
            check_publication(module, failure)
    print('publication checks ok: both generators preserve bundle/assets on write and replace failures, then publish/prune successfully')
