1. 3D skew technique - 3 Axes: 
 - a skewed grid, and a set of uniformed 3d models, and I want to fit these 3d assets into the skewed grid.
2. 3D assets modeling
3. Data processing optimization (buffer)
4. Platform: Unreal, Unity or Three.js

instructions:
1
to test the three 2d relaxation algorithms. 1. the user can set the size of the board, an    
  interger 6 - 20, 2. choose from one of the three algorithms, 3. parameters to adjust: number of iterations, the strength of           
  compensation. 4. it should show the max, min and stdDev of the quad size and edge length.                                             
make a tool page, and extract the code as needed, do not touch the existing files. and make a selfsufficient file for it.


Instructions:
I now have a sketchup file with all my 3D assets, which is the same as the input file "toChop.png" in imageChopping.py. now we need to do the same processing to the 3D assets.
1 the assets are in rows and columns, like in the code of imageChopping.py, just the distancing between the rows and columns are different. 
first row centers at (0,-15,0), second row centers at (0, -75, 0),...
first column centers at (15, 0, 0), second column centers at (75, 0, 0),...
we need to do a traversing all element in the sketchup file, to detect which tile each asset belongs to. 
if ((x + 15) / 60) > 0 and < 1 then i = 0 , if ((x + 15) / 60) > 1 and < 2 then i = 1, ...
if ((y - 15) / 60) > -1 and < 0 then j = 0 , if ((y - 15) / 60) > -2 and < -1 then j = 1, ...
then we can assign the asset to the tile (i, j).  the model center of (i, j) is (15 + 60 * i, -15 - 60 * j, 0).
then we export the assets in each tile into a separate file, with the 4 digits file name like this, but just in stl file format, since we are working in 3D:

# part 1: 4 axial symmetry, no mirror no rotation

file_names_part1 = [
    # row 1
    ["wwww.png", "rrrr.png", "1111.png", "2222.png", "cccc.png"]
]

# part 2: 2 axial symmetry, - mirror to exhaust
file_names_part2 = [
    # row 2
    ["wrwr.png", "w1w1.png", "w2w2.png", "wcwc.png"],
    # row 3
    ["r1r1.png", "r2r2.png", "rcrc.png", "1212.png", "1c1c.png", "2c2c.png"]
]

# part 3: 1 axial symmetry, -rotate 3 times to exhaust
file_names_part3 = [
    # row 4
    ["wwrr.png", "ww11.png", "ww22.png", "wwcc.png", "rr11.png", "rr22.png", "rrcc.png"],
    # row 5
    ["1122.png", "11cc.png", "22cc.png"],
    # row 6
    ["wwrw.png", "ww1w.png", "ww2w.png", "wwcw.png", "rrwr.png", "rr1r.png", "rr2r.png", "rrcr.png"],
    # row 7
    ["11w1.png", "11r1.png", "1121.png", "11c1.png", "22w2.png", "22r2.png", "2212.png", "22c2.png"],
    # row 8
    ["ccwc.png", "ccrc.png", "cc1c.png", "cc2c.png"],
    # row 9
    ["w1wr.png", "w2wr.png", "wcwr.png", "w2w1.png", "wcw1.png", "wcw2.png"],
    # row 10
    ["r1rw.png", "r2rw.png", "rcrw.png", "r2r1.png", "rcr1.png", "rcr2.png"],
    # row 11
    ["1r1w.png", "121w.png", "1c1w.png", "121r.png", "1c1r.png", "1c12.png"],
    # row 12
    ["2r2w.png", "212w.png", "2c2w.png", "212r.png", "2c2r.png", "2c21.png"],
    # row 13
    ["crcw.png", "c1cw.png", "c2cw.png", "c1cr.png", "c2cr.png", "c2c1.png"]
]

# part 4: no symmetry, -rotate 3 times and each mirror
file_names_part4 = [
    # row 14
    ["wr21.png", "wrc1.png", "wr2c.png", "wc21.png", "cr21.png"],
    # row 15
    ["w2r1.png", "wcr1.png", "w2rc.png", "w2c1.png", "c2r1.png"],
    # row 16
    ["wr12.png", "wr1c.png", "wrc2.png", "wc12.png", "cr12.png"],
    # row 17
    ["ww1r.png", "ww2r.png", "wwcr.png", "ww21.png", "wwc1.png", "wwc2.png"],
    # row 18
    ["rr1w.png", "rr2w.png", "rrcw.png", "rr21.png", "rrc1.png", "rrc2.png"],
    # row 19
    ["11rw.png", "112w.png", "11cw.png", "112r.png", "11cr.png", "11c2.png"],
    # row 20
    ["22rw.png", "221w.png", "22cw.png", "221r.png", "22cr.png", "22c1.png"],
    # row 21
    ["ccrw.png", "cc1w.png", "cc2w.png", "cc1r.png", "cc2r.png", "cc21.png"]
]

it is to work in sketchup, if you can, do it. otherwise maybe we run a ruby script in sketchup to do the processing.

extend the exporting to the functionality of createAtlas.py. which create a full set of 3D assets by rotating and mirroring the original assets. we first put all the assets in a folder, then we put them all into a glb file, in an array like in createAtlas.py. with distancing of 60m

instructions:
next is a large step, think about how to implement it. \2511_Hexagonal_World\index.html is a       
  simulation that spawn buildings in a quadrangulated grid with vertices that has multiple attributes. It drwas with p5.js. we essentially do the same thing, just  use three.js as we have started in root\index.html.
  you need to read the code in \2511_Hexagonal_World\index.html, and understand how it works, and then implement the same thing in three.js. you can actually use large part of that code, only change the graphics and drawing related code. try to complete it. if you can not do it in one shot, make a plan to do it step by step.

❯ you need to look at the original code detail - we spawn far more merchants and farmers  
  than castle, castle probability is very low. you can create a HUD value control for the  
  probabilities of them, adding to 100% in total. and you need to also set up a path       
  finding parameter panel. and there're two accessible level parameters ( a close          
  influence and a far inflence distance cost), we need control of these two parameters     
  too in the panel.    


instruction:
the skewing of the building blocks with the elevation of the highest vertices of the quad added to the building seems false. a clean skewing without the elevation add should be used instead

instruction:
❯ 1.look into the styles of the 2D version interface, the buttons are circular and look nicer. the 
  auto simulate button is bigger than the others.                                                 
  turn off the settlement marker by default. 
  2. the 2D version has a cross region trade route created at the beginning, whose start-end points were hard coded. but we do a randomly generated route in this version. the start and end points are at the vertices (a sign of edge vertex is that it is in only 2 quads), and the euclideandistance between them should be larger than the z span of the board. all merchants when spawned will also do pathfinding to the start-end points of the regional trade route. take reference from the 2D version.
  3. path dependency in path- finding : a travel on a path will reduce the cost factor of it. this factor start with 1.0, when number of travel = 1; factor = 1/2/n + 1/2; the factor is stored in the vertex - neighbor attribute. 
  4. the color code for defense value is not well ranged. it should have larger range of color, yellow - green - blue spanning the high to low.
  5. the elevation color code should follow the classical code.
  6. the farmhouse "1" should be upgraded to merchant "2", once it has a higher merchant value. I am not sure about the exact value, I think it should be some value where travelled for 20 times or so.
  7. the "farm value" should have a penalty for high ground, I am not sure if it is implemented. it should be. now the fare value does not show a high range.
  8. use the music, the starting interface, but don't make kinect option. but use the three cities "hongkong, rome, tokyo" and wire in the map json they use. copy the assets to the project folder.

instruction:
draw the traffic routes in the way that the width is proportional to the traffic flow.

instruction:
influence range: close to 50, far to 150
