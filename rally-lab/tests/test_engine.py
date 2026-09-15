import copy
import unittest

import numpy as np

from backend.engine import DEFAULTS, Engine, ScoreBook, combine_votes, cross_pose


def pose(cross=False, shift=0, scale=1):
    p = [[.5, .5, 1.] for _ in range(33)]
    joints = {0:(.5,.15),11:(.4,.4),12:(.6,.4),13:(.38,.5),14:(.62,.5),
              15:(.35,.65),16:(.65,.65),23:(.43,.67),24:(.57,.67),
              25:(.43,.8),26:(.57,.8),27:(.43,.95),28:(.57,.95)}
    if cross:
        joints.update({15:(.6,.32),16:(.4,.32)})
    for i,(x,y) in joints.items():
        p[i] = [(x-.5)*scale+.5+shift,y,1.]
    return p


class ScoringTests(unittest.TestCase):
    def test_flip_transfers_one_point_and_replays_serve(self):
        book=ScoreBook()
        book.add('A', 0);book.add('B', 2)
        self.assertTrue(book.flip(3, 15))
        self.assertEqual(book.state()['points'], {'A':2,'B':0})
        self.assertEqual(book.state()['server'], 'A')
        self.assertFalse(book.flip(4, 15))
        self.assertEqual(sum(book.state()['points'].values()),2)

    def test_old_or_future_point_not_corrected(self):
        book=ScoreBook();book.add('A',20)
        self.assertFalse(book.flip(19,15));self.assertFalse(book.flip(36,15))

    def test_deuce_cap_and_match_final_correction(self):
        b=ScoreBook()
        for i in range(29):
            b.add('A',i);b.add('B',i)
        b.add('A',30)
        self.assertEqual(b.state()['completed'],[{'A':30,'B':29}])
        for i in range(21):b.add('A',40+i)
        self.assertTrue(b.state()['match_over'])
        self.assertFalse(b.add('B',62))
        self.assertTrue(b.flip(61,15))
        self.assertFalse(b.state()['match_over'])
        self.assertEqual(b.state()['points'],{'A':20,'B':1})

    def test_deuce_requires_two(self):
        b=ScoreBook()
        for i in range(20):b.add('A',i);b.add('B',i)
        b.add('A',21)
        self.assertEqual(b.state()['games']['A'],0)
        b.add('A',22)
        self.assertEqual(b.state()['completed'][0],{'A':22,'B':20})


class VoteTests(unittest.TestCase):
    def test_disabled_conflicting_and_correlated_votes_abstain(self):
        settings={**DEFAULTS, 'threshold':.3, 'last_hit':True}
        votes=[{'algorithm':'last_hit','winner':'A','strength':.38,'family':'pose'},
               {'algorithm':'pickup','winner':'A','strength':.32,'family':'pose'}]
        self.assertIsNone(combine_votes(votes,settings))
        votes.append({'algorithm':'landing','winner':'A','strength':.58,'family':'shuttle'})
        self.assertEqual(combine_votes(votes,settings)['winner'],'A')
        votes[0]['winner']='B'
        self.assertIsNone(combine_votes(votes,settings))
        self.assertIsNone(combine_votes(votes,{**settings,'landing':False,'last_hit':False,'pickup':False}))

    def test_single_opt_in_and_threshold(self):
        v=[{'algorithm':'landing','winner':'B','strength':.58,'family':'shuttle'}]
        self.assertIsNone(combine_votes(v,DEFAULTS))
        self.assertEqual(combine_votes(v,{**DEFAULTS,'fusion':'single','threshold':.5})['winner'],'B')


class GestureTests(unittest.TestCase):
    def setUp(self):
        self.frame=np.zeros((360,640,3),np.uint8)

    def test_x_requires_crossing_and_visibility(self):
        self.assertTrue(cross_pose(pose(True)))
        self.assertFalse(cross_pose(pose()))
        low=pose(True);low[15][2]=.2
        self.assertFalse(cross_pose(low))

    def test_any_of_four_players_can_correct_only_once(self):
        for who in range(4):
            engine=Engine();engine.book.add('B',0)
            people=[pose(i==who,(i-1.5)*.23,.4) for i in range(4)]
            for i in range(26):result=engine.process(self.frame,.1+i*.1,'score',people)
            self.assertEqual(result['score']['points'],{'A':1,'B':0})
            self.assertTrue(result['score']['events'][-1]['corrected'])

    def test_gap_missing_person_and_active_rally_block(self):
        engine=Engine();engine.book.add('B',0)
        for t in [.1,.3,.5,.7,.9]:engine.process(self.frame,t,'score',[pose(True)])
        engine.process(self.frame,1.,'score',[])
        result=engine.process(self.frame,1.1,'score',[pose(True)])
        self.assertEqual(result['score']['points']['B'],1)
        result=engine.process(self.frame,3.,'score',[pose(True)])
        self.assertEqual(result['gesture_progress'],0)
        engine.rally_start=3.;engine.last_action=4.
        for i in range(14):result=engine.process(self.frame,3.1+i*.1,'score',[pose(True)])
        self.assertEqual(result['score']['points']['B'],1)

    def test_no_people_no_automatic_points(self):
        engine=Engine()
        for i in range(50):result=engine.process(self.frame,i*.2,'score',[])
        self.assertEqual(result['score']['total_events'],0)

    def test_temporal_rally_to_experimental_score_then_x(self):
        settings={'court':[[.05,.99],[.95,.99],[.8,.05],[.2,.05]],
                  'fusion':'single','threshold':.3,'last_hit':True,'landing':False,'pickup':False}
        engine=Engine(settings)
        p=pose()
        for i in range(20):
            p=copy.deepcopy(p);p[16]=[.7,.2 if i%2 else .4,1.]
            frame=np.full_like(self.frame,20 if i%2 else 80)
            engine.process(frame,i*.2,'score',[p])
        for i in range(21,37):r=engine.process(frame,i*.2,'score',[p])
        self.assertEqual(r['score']['points'],{'A':1,'B':0})
        self.assertEqual(len(r['clips']),1)
        for i in range(37,47):r=engine.process(frame,i*.2,'score',[pose(True)])
        self.assertEqual(r['score']['points'],{'A':0,'B':1})

    def test_court_mapping_and_clip_merge(self):
        engine=Engine({'court':[[.1,.95],[.9,.95],[.65,.1],[.35,.1]]})
        self.assertEqual(engine.team_at(.5,.85),'A')
        self.assertEqual(engine.team_at(.5,.15),'B')
        self.assertIsNone(engine.team_at(.01,.5))
        engine.clips=[{'start':0,'end':2},{'start':1,'end':3},{'start':5,'end':8}]
        self.assertEqual(engine.finish(6),[{'start':0,'end':3},{'start':5,'end':6}])


if __name__=='__main__':unittest.main()
